declare module "@drowl87/netsuite-rest-api-client" {
    export function makeRequest(
        config: Record<string, any>,
        requestOptions: Record<string, any>
    ): Promise<any>;
}
