import { DurableObject } from "cloudflare:workers";
import type { Env } from "./types";

// Region-pinned egress relay. OpenAI geo-blocks requests that egress from some Cloudflare
// colos (e.g. Hong Kong) with 403 unsupported_country_region_territory. A Worker's fetch()
// egresses from whatever colo the invocation runs in, and that is fixed per invocation, so an
// in-invocation retry cannot escape a bad colo. Routing the request to this Durable Object via
// locationHint:"wnam" makes the object run in North America; its outbound fetch() then egresses
// from an OpenAI-supported region. The real key never leaves Cloudflare.
export class UsEgress extends DurableObject<Env> {
	override fetch(request: Request): Promise<Response> {
		return fetch(request);
	}
}
