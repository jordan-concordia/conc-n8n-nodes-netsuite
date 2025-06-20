import { debuglog } from 'util';
import crypto from 'crypto';
import {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
} from 'n8n-workflow';

import {
	INetSuiteCredentials,
	INetSuiteOperationOptions,
	INetSuitePagedBody,
	INetSuiteRequestOptions,
	INetSuiteResponse,
	NetSuiteRequestType,
} from './NetSuite.node.types';

import {
	nodeDescription,
} from './NetSuite.node.options';

import { makeRequest } from '@drowl87/netsuite-rest-api-client';
import pLimit from '@common.js/p-limit';
import fetch from 'node-fetch';

const debug = debuglog('n8n-nodes-netsuite');

// Custom function to make restlet requests without the Prefer header
const makeRestletRequest = async (config: any, requestData: any) => {
	const {
		netsuiteApiHost,
		consumerKey,
		consumerSecret,
		netsuiteAccountId,
		netsuiteTokenKey,
		netsuiteTokenSecret
	} = config;

	// Generate OAuth signature
	const generateOAuthSignature = (method: string, url: string, extraParams: any = {}) => {
		const timestamp = Math.floor(Date.now() / 1000).toString();
		const nonce = crypto.randomBytes(16).toString('hex');
		
		const oauthParams = {
			oauth_consumer_key: consumerKey,
			oauth_nonce: nonce,
			oauth_signature_method: 'HMAC-SHA256',
			oauth_timestamp: timestamp,
			oauth_token: netsuiteTokenKey,
			oauth_version: '1.0'
		};

		// Create parameter string
		const urlObj      = new URL(url);
    	const queryParams = Object.fromEntries(urlObj.searchParams.entries());
    	const allParams   = { ...oauthParams, ...queryParams, ...extraParams };
		const paramString = Object.keys(allParams)
			.sort()
			.map(key => `${encodeURIComponent(key)}=${encodeURIComponent(allParams[key])}`)
			.join('&');

		// Create signature base string
		const baseUrl    = `${urlObj.protocol}//${urlObj.host}${urlObj.pathname}`;
    	const baseString = `${method.toUpperCase()}&${encodeURIComponent(baseUrl)}&${encodeURIComponent(paramString)}`;
		// Create signing key
		const signingKey = `${encodeURIComponent(consumerSecret)}&${encodeURIComponent(netsuiteTokenSecret)}`;

		// Generate signature
		const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

		return {
			...oauthParams,
			oauth_signature: signature
		};
	};

	const url = requestData.nextUrl;
	const method = requestData.method;
	const body = requestData.query ? JSON.stringify(requestData.query) : undefined;

	// Generate OAuth header
	const oauthParams = generateOAuthSignature(method, url, {});
	const authHeader = 'OAuth realm="' + netsuiteAccountId + '", ' + Object.keys(oauthParams)
		.map(key => `${key}="${encodeURIComponent(oauthParams[key])}"`)
		.join(', ');

	// Make the request using node-fetch
	const headers = {
		'Authorization': authHeader,
		'Content-Type': 'application/json',
		'Accept': 'application/json',
		'Accept-Language': 'en',
		'Content-Language': 'en'
		// Deliberately NOT including Prefer: transient
	};

	console.log('Custom restlet request - URL:', url);
	console.log('Custom restlet request - Method:', method);
	console.log('Custom restlet request - Headers:', headers);
	console.log('Custom restlet request - Body:', body);

	try {
		const response = await fetch(url, {
			method,
			headers,
			body
		});

		const responseText = await response.text();
		let responseBody;
		
		try {
			responseBody = JSON.parse(responseText);
		} catch {
			responseBody = responseText;
		}

		console.log('Custom restlet response - Status:', response.status);
		console.log('Custom restlet response - Body:', responseBody);

		return {
			statusCode: response.status,
			statusText: response.statusText,
			headers: Object.fromEntries(response.headers.entries()),
			body: responseBody,
			request: {
				options: {
					method,
					headers,
					url
				}
			}
		};
	} catch (error) {
		console.error('Custom restlet request failed:', error);
		throw error;
	}
};

// Create a wrapper function to handle the prefer header removal for restlets
const makeNetSuiteRequest = async (config: any, requestData: any) => {
	// Check if this is a restlet request
	const isRestletRequest = requestData.nextUrl && requestData.nextUrl.includes('restlets.api.netsuite.com');
	
	if (isRestletRequest) {
		console.log('Detected restlet request, using custom request function');
		return makeRestletRequest(config, requestData);
	}
	
	// For non-restlet requests, use the original client
	console.log('Using standard NetSuite client');
	return makeRequest(config, requestData);
};

const handleNetsuiteResponse = (fns: IExecuteFunctions, response: INetSuiteResponse) => {
	// debug(response);
	debug(`Netsuite response:`, response.statusCode, response.body);
	let body: JsonObject = {};
	const {
		title: webTitle = undefined,
		// code: restletCode = undefined,
		'o:errorCode': webCode,
		'o:errorDetails': webDetails,
		message: restletMessage = undefined,
	} = response.body;
	if (!(response.statusCode && response.statusCode >= 200 && response.statusCode < 400)) {
		let message = webTitle || restletMessage || webCode || response.statusText;
		if (webDetails && webDetails.length > 0) {
			message = webDetails[0].detail || message;
		}
		if (fns.continueOnFail() !== true) {
			// const code = webCode || restletCode;
			const error = new NodeApiError(fns.getNode(), response.body);
			error.message = message;
			throw error;
		} else {
			body = {
				error: message,
			};
		}
	} else {
		body = response.body;
		// Ensure response.request.options is not null and has a 'method' property.
		const requestOptions = response.request.options as { method?: string } | null;
		if (requestOptions?.method && [ 'POST', 'PATCH', 'DELETE' ].includes(requestOptions.method)) {
			body = typeof body === 'object' ? response.body : {};
			if (response.headers['x-netsuite-propertyvalidation']) {
				body.propertyValidation = response.headers['x-netsuite-propertyvalidation'].split(',');
			}
			if (response.headers['x-n-operationid']) {
				body.operationId = response.headers['x-n-operationid'];
			}
			if (response.headers['x-netsuite-jobid']) {
				body.jobId = response.headers['x-netsuite-jobid'];
			}
			if (response.headers['location']) {
				body.links = [
					{
						rel: 'self',
						href: response.headers['location'],
					},
				];
				// Guard against undefined: split and check the result.
				const locParts = response.headers['location'].split('/');
				const locId = locParts.pop() ?? null;
				if (locId !== null) {
					body.id = locId;
				}
			}
			body.success = response.statusCode === 204;
		}
	}
	// debug(body);
	return { json: body };
};

const getConfig = (credentials: INetSuiteCredentials) => ({
	netsuiteApiHost: credentials.hostname,
	consumerKey: credentials.consumerKey,
	consumerSecret: credentials.consumerSecret,
	netsuiteAccountId: credentials.accountId,
	netsuiteTokenKey: credentials.tokenKey,
	netsuiteTokenSecret: credentials.tokenSecret,
	netsuiteQueryLimit: 1000,
});

export class NetSuite implements INodeType {
	description: INodeTypeDescription = nodeDescription;

	static getRecordType({ fns, itemIndex }: INetSuiteOperationOptions): string {
		let recordType = fns.getNodeParameter('recordType', itemIndex) as string;
		if (recordType === 'custom') {
			recordType = fns.getNodeParameter('customRecordTypeScriptId', itemIndex) as string;
		}
		return recordType;
	}

	static async listRecords(options: INetSuiteOperationOptions): Promise<INodeExecutionData[]> {
		const { fns, credentials, itemIndex } = options;
		const nodeContext = fns.getContext('node');
		const apiVersion = fns.getNodeParameter('version', itemIndex) as string;
		const recordType = NetSuite.getRecordType(options);
		const returnAll = fns.getNodeParameter('returnAll', itemIndex) as boolean;
		const query = fns.getNodeParameter('query', itemIndex) as string;
		let limit = 100;
		let offset = 0;
		let hasMore = true;
		const method = 'GET';
		let nextUrl;
		const requestType = NetSuiteRequestType.Record;
		const params = new URLSearchParams();
		const returnData: INodeExecutionData[] = [];
		let prefix = query ? `?${query}` : '';
		if (returnAll !== true) {
			prefix = query ? `${prefix}&` : '?';
			limit = fns.getNodeParameter('limit', itemIndex) as number || limit;
			offset = fns.getNodeParameter('offset', itemIndex) as number || offset;
			params.set('limit', String(limit));
			params.set('offset', String(offset));
			prefix += params.toString();
		}
		const requestData: INetSuiteRequestOptions = {
			method,
			requestType,
			path: `services/rest/record/${apiVersion}/${recordType}${prefix}`,
		};
		nodeContext.hasMore = hasMore;
		nodeContext.count = limit;
		nodeContext.offset = offset;
		// debug('requestData', requestData);
		while ((returnAll || returnData.length < limit) && hasMore === true) {
			const response = await makeRequest(getConfig(credentials), requestData);
			const body: JsonObject = handleNetsuiteResponse(fns, response);
			const { hasMore: doContinue, items, links, offset, count, totalResults } = (body.json as INetSuitePagedBody);
			if (doContinue) {
				nextUrl = (links.find((link) => link.rel === 'next') || {}).href;
				requestData.nextUrl = nextUrl;
			}
			if (Array.isArray(items)) {
				for (const json of items) {
					if (returnAll || returnData.length < limit) {
						returnData.push({ json });
					}
				}
			}
			hasMore = doContinue && (returnAll || returnData.length < limit);
			nodeContext.hasMore = doContinue;
			nodeContext.count = count;
			nodeContext.offset = offset;
			nodeContext.totalResults = totalResults;
			if (requestData.nextUrl) {
				nodeContext.nextUrl = requestData.nextUrl;
			}
		}
		return returnData;
	}

	static async runSuiteQL(options: INetSuiteOperationOptions): Promise<INodeExecutionData[]> {
		const { fns, credentials, itemIndex } = options;
		const nodeContext = fns.getContext('node');
		const apiVersion = fns.getNodeParameter('version', itemIndex) as string;
		const returnAll = fns.getNodeParameter('returnAll', itemIndex) as boolean;
		// For SuiteQL the query is provided as a string.
		const query = fns.getNodeParameter('query', itemIndex) as string;
		let limit = 1000;
		let offset = 0;
		let hasMore = true;
		const method = 'POST';
		let nextUrl;
		const requestType = NetSuiteRequestType.SuiteQL;
		const params = new URLSearchParams();
		const returnData: INodeExecutionData[] = [];
		const config = getConfig(credentials);
		let prefix = '?';
		if (returnAll !== true) {
			limit = fns.getNodeParameter('limit', itemIndex) as number || limit;
			offset = fns.getNodeParameter('offset', itemIndex) as number || offset;
			params.set('offset', String(offset));
		}
		params.set('limit', String(limit));
		config.netsuiteQueryLimit = limit;
		prefix += params.toString();
		const requestData: INetSuiteRequestOptions = {
		    method,
		    requestType,
		    query: query,
		    path: `services/rest/query/${apiVersion}/suiteql${prefix}`,
		    headers: {
		        "Content-Type": "application/json",
		        "Prefer": "transient",
		    },
		};

		// Temp logging for debugging:
    	// console.log('requestData:', JSON.stringify(requestData, null, 2));
		
		nodeContext.hasMore = hasMore;
		nodeContext.count = limit;
		nodeContext.offset = offset;
		debug('requestData', requestData);
		while ((returnAll || returnData.length < limit) && hasMore === true) {
			const response = await makeRequest(config, requestData);
			const body: JsonObject = handleNetsuiteResponse(fns, response);
			const { hasMore: doContinue, items, links, count, totalResults, offset } = (body.json as INetSuitePagedBody);
			if (doContinue) {
				nextUrl = (links.find((link) => link.rel === 'next') || {}).href;
				requestData.nextUrl = nextUrl;
			}
			if (Array.isArray(items)) {
				for (const json of items) {
					if (returnAll || returnData.length < limit) {
						returnData.push({ json });
					}
				}
			}
			hasMore = doContinue && (returnAll || returnData.length < limit);
			nodeContext.hasMore = doContinue;
			nodeContext.count = count;
			nodeContext.offset = offset;
			nodeContext.totalResults = totalResults;
			if (requestData.nextUrl) {
				nodeContext.nextUrl = requestData.nextUrl;
			}
		}
		return returnData;
	}

	static async getRecord(options: INetSuiteOperationOptions): Promise<INodeExecutionData> {
		const { item, fns, credentials, itemIndex } = options;
		const params = new URLSearchParams();
		const expandSubResources = fns.getNodeParameter('expandSubResources', itemIndex) as boolean;
		const simpleEnumFormat = fns.getNodeParameter('simpleEnumFormat', itemIndex) as boolean;
		const apiVersion = fns.getNodeParameter('version', itemIndex) as string;
		const recordType = NetSuite.getRecordType(options);
		const internalId = fns.getNodeParameter('internalId', itemIndex) as string;
		if (expandSubResources) {
			params.append('expandSubResources', 'true');
		}
		if (simpleEnumFormat) {
			params.append('simpleEnumFormat', 'true');
		}
		const q = params.toString();
		const requestData = {
			method: 'GET',
			requestType: NetSuiteRequestType.Record,
			path: `services/rest/record/${apiVersion}/${recordType}/${internalId}${q ? `?${q}` : ''}`,
		};
		const response = await makeRequest(getConfig(credentials), requestData);
		if (item) response.body.orderNo = item.json.orderNo;
		return handleNetsuiteResponse(fns, response);
	}

	static async removeRecord(options: INetSuiteOperationOptions): Promise<INodeExecutionData> {
		const { fns, credentials, itemIndex } = options;
		const apiVersion = fns.getNodeParameter('version', itemIndex) as string;
		const recordType = NetSuite.getRecordType(options);
		const internalId = fns.getNodeParameter('internalId', itemIndex) as string;
		const requestData = {
			method: 'DELETE',
			requestType: NetSuiteRequestType.Record,
			path: `services/rest/record/${apiVersion}/${recordType}/${internalId}`,
		};
		const response = await makeRequest(getConfig(credentials), requestData);
		return handleNetsuiteResponse(fns, response);
	}

	static async insertRecord(options: INetSuiteOperationOptions): Promise<INodeExecutionData> {
		const { fns, credentials, itemIndex, item } = options;
		const apiVersion = fns.getNodeParameter('version', itemIndex) as string;
		const recordType = NetSuite.getRecordType(options);
		// Expecting an object from the incoming item.
		const useCustomJson = fns.getNodeParameter('useCustomJson', itemIndex, false);
		let query;
		if (useCustomJson) {
			const raw = fns.getNodeParameter('customJson', itemIndex);
			if (typeof raw === 'string') {
			try {
				query = JSON.parse(raw);
			} catch {
				throw new Error('customJson must be valid JSON');
			}
			} else {
			query = raw as Record<string, any>;
			}
		} else {
			query = item?.json as Record<string, any> | undefined;
		}
		const requestData: INetSuiteRequestOptions = {
				method: 'POST',
				requestType: NetSuiteRequestType.Record,
				path: `services/rest/record/${apiVersion}/${recordType}`,
		};
		if (query) {
				// Cast to the expected type.
				requestData.query = query as Record<string, string | number | boolean>;
		}
		console.log('>>> n8n is about to send to NetSuite:', JSON.stringify(requestData, null, 2));
		console.log(query);
		const response = await makeRequest(getConfig(credentials), requestData);
		return handleNetsuiteResponse(fns, response);
    }

	static async updateRecord(options: INetSuiteOperationOptions): Promise<INodeExecutionData> {
		const { fns, credentials, itemIndex, item } = options;
		const apiVersion = fns.getNodeParameter('version', itemIndex) as string;
		const recordType = NetSuite.getRecordType(options);
		const internalId = fns.getNodeParameter('internalId', itemIndex) as string;
		// Expecting an object from the incoming item.
		const useCustomJson = fns.getNodeParameter('useCustomJson', itemIndex, false);
		let query;
		if (useCustomJson) {
			const raw = fns.getNodeParameter('customJson', itemIndex);
			if (typeof raw === 'string') {
			try {
				query = JSON.parse(raw);
			} catch {
				throw new Error('customJson must be valid JSON');
			}
			} else {
			query = raw as Record<string, any>;
			}
		} else {
			query = item?.json as Record<string, any> | undefined;
		}
		const requestData: INetSuiteRequestOptions = {
				method: 'PATCH',
				requestType: NetSuiteRequestType.Record,
				path: `services/rest/record/${apiVersion}/${recordType}/${internalId}`,
		};
		if (query) {
				// Cast to the expected type.
				requestData.query = query as Record<string, string | number | boolean>;
		}
		console.log('>>> n8n is about to send to NetSuite:', JSON.stringify(requestData, null, 2));
		console.log(query);
		const response = await makeRequest(getConfig(credentials), requestData);
		return handleNetsuiteResponse(fns, response);
    }

	static async rawRequest(options: INetSuiteOperationOptions): Promise<INodeExecutionData | INodeExecutionData[]> {
		const { fns, credentials, itemIndex, item } = options;
		const nodeContext = fns.getContext('node');
		let path = fns.getNodeParameter('path', itemIndex) as string;
		const method = fns.getNodeParameter('method', itemIndex) as string;
		const body = fns.getNodeParameter('body', itemIndex) as string;
		const requestType = fns.getNodeParameter('requestType', itemIndex) as NetSuiteRequestType;
		// The query can come as a string (body) or an object (from the item).
		const query = body || (item ? item.json : undefined);
		const nodeOptions = fns.getNodeParameter('options', 0) as IDataObject;
	
		const fullUrl = `https://${credentials.hostname}${path}`;
		const requestData: INetSuiteRequestOptions = {
			method,
			requestType, 
			nextUrl: fullUrl,
			headers: {
				'Content-Type': 'application/json',
    			'Accept': 'application/json',
			}
		};
	
		if (query && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
			try {
				const parsedQuery = typeof query === 'string' ? JSON.parse(query) : query;
				if (typeof parsedQuery === 'string') {
					requestData.query = parsedQuery;
				} else {
					// Cast the parsed object to the expected type.
					requestData.query = parsedQuery as Record<string, string | number | boolean>;
				}
			} catch {
				requestData.query = query as string | Record<string, string | number | boolean> | undefined;
			}
		}
	
		// Manually strip "query" wrapper if it exists
		if (typeof requestData.query === 'object' && 'query' in requestData.query) {
			requestData.query = (requestData.query as any).query;
		}

		console.log('URL:', requestData.nextUrl || `https://${credentials.hostname}${path}`);
		console.log('Method:', requestData.method);
		console.log('Headers:', requestData.headers);
		console.log('Body:', requestData.query);

		console.log('>>> NetSuite client config:', JSON.stringify(getConfig(credentials), null, 2));
		console.log('Final cleaned requestData:', JSON.stringify(requestData, null, 2));
		
		// Use our custom wrapper function that handles restlet requests
		const response = await makeNetSuiteRequest(getConfig(credentials), requestData);
		
		console.log('Response status:', response.statusCode);
		console.log('Response body:', response.body);
	
		if (response.body) {
			nodeContext.hasMore = response.body.hasMore;
			nodeContext.count = response.body.count;
			nodeContext.offset = response.body.offset;
			nodeContext.totalResults = response.body.totalResults;
		}
	
		if (nodeOptions.fullResponse) {
			return {
				json: {
					statusCode: response.statusCode,
					headers: response.headers,
					body: response.body,
				},
			};
		} else {
			if (Array.isArray(response.body)) {
			console.log(`Splitting array response into ${response.body.length} individual items`);
			return response.body.map((item: any) => ({ json: item }));
		} else {
			return { json: response.body };
		}
		}
	}

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const credentials: INetSuiteCredentials = (await this.getCredentials('netsuite')) as INetSuiteCredentials;
		const operation = this.getNodeParameter('operation', 0) as string;
		const items: INodeExecutionData[] = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		const promises = [];
		const options = this.getNodeParameter('options', 0) as IDataObject;
		const concurrency = (options.concurrency as number) || 1;
		const limit = pLimit(concurrency);

		for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
			const item: INodeExecutionData = items[itemIndex];
			let data: INodeExecutionData | INodeExecutionData[];

			promises.push(limit(async () => {
				debug(`Processing ${operation} for ${itemIndex + 1} of ${items.length}`);
				if (operation === 'getRecord') {
					data = await NetSuite.getRecord({ item, fns: this, credentials, itemIndex });
				} else if (operation === 'listRecords') {
					data = await NetSuite.listRecords({ item, fns: this, credentials, itemIndex });
				} else if (operation === 'removeRecord') {
					data = await NetSuite.removeRecord({ item, fns: this, credentials, itemIndex });
				} else if (operation === 'insertRecord') {
					data = await NetSuite.insertRecord({ item, fns: this, credentials, itemIndex });
				} else if (operation === 'updateRecord') {
					data = await NetSuite.updateRecord({ item, fns: this, credentials, itemIndex });
				} else if (operation === 'rawRequest') {
					data = await NetSuite.rawRequest({ item, fns: this, credentials, itemIndex });
				} else if (operation === 'runSuiteQL') {
					data = await NetSuite.runSuiteQL({ item, fns: this, credentials, itemIndex });
				} else {
					const error = `The operation "${operation}" is not supported!`;
					if (this.continueOnFail() !== true) {
						throw new Error(error);
					} else {
						data = { json: { error } };
					}
				}
				return data;
			}));
		}

		const results = await Promise.all(promises);
		for await (const result of results) {
			if (result) {
				if (Array.isArray(result)) {
					returnData.push(...result);
				} else {
					returnData.push(result);
				}
			}
		}

		return this.prepareOutputData(returnData);
	}
}