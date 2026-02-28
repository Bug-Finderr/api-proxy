export default {
	async fetch(request: Request, env: { GEMINI_API_KEY: string }): Promise<Response> {
		const url = new URL(request.url);
		url.hostname = "generativelanguage.googleapis.com";
		url.protocol = "https:";
		url.searchParams.delete("key");

		const headers = new Headers(request.headers);
		headers.set("x-goog-api-key", env.GEMINI_API_KEY);

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
