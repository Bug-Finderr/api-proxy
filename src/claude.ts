export default {
	async fetch(request: Request, env: { ANTHROPIC_API_KEY: string }): Promise<Response> {
		const url = new URL(request.url);
		url.hostname = "api.anthropic.com";
		url.protocol = "https:";

		const headers = new Headers(request.headers);
		headers.set("x-api-key", env.ANTHROPIC_API_KEY);

		const response = await fetch(
			new Request(url.toString(), {
				method: request.method,
				headers,
				body: request.body,
			}),
		);

		return new Response(response.body, response);
	},
};
