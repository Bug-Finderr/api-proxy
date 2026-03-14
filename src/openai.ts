export default {
	async fetch(request: Request, env: { OPENAI_API_KEY: string }): Promise<Response> {
		const url = new URL(request.url);
		url.hostname = "api.openai.com";
		url.protocol = "https:";

		const headers = new Headers(request.headers);
		headers.set("Authorization", `Bearer ${env.OPENAI_API_KEY}`);

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
