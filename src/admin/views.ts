import { html, raw } from "hono/html";
import type { CoarseProvider, TokenMetadata } from "../types";

type Row = TokenMetadata & { hash: string; lastUsed?: string };

const HTMX = "https://unpkg.com/htmx.org@2.0.9";

const STYLE = `
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:#0b0b10;color:#e7e7ea;font:14px/1.5 ui-sans-serif,system-ui,sans-serif}
.wrap{max-width:920px;margin:0 auto;padding:28px 20px}
h1{font-size:20px;font-weight:600;margin:0 0 20px}
.card{background:#15151c;border:1px solid #24242e;border-radius:12px;padding:18px;margin:0 0 18px}
.card h2{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#9a9aa6;margin:0 0 14px}
label{display:block;font-size:12px;color:#9a9aa6;margin:0 0 4px}
input[type=text],input[type=password],input[type=datetime-local]{width:100%;background:#0e0e14;border:1px solid #2a2a36;border-radius:8px;color:#e7e7ea;padding:9px 11px;font:inherit}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end}
.row>div{flex:1;min-width:160px}
.checks{display:flex;gap:14px;margin:12px 0}
.checks label{display:flex;align-items:center;gap:6px;color:#cfcfd6;margin:0}
button{background:#5b5bd6;color:#fff;border:0;border-radius:8px;padding:9px 16px;font:inherit;font-weight:600;cursor:pointer}
button.ghost{background:transparent;border:1px solid #2a2a36;color:#cfcfd6;padding:5px 10px;font-weight:500}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:#73737f;padding:0 8px 10px;font-weight:600}
td{padding:10px 8px;border-top:1px solid #20202a;vertical-align:middle}
.mono{font-family:ui-monospace,monospace}
.pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:999px;margin-right:4px}
.openai{background:#0c3b2e;color:#74e0bb}.anthropic{background:#3a2740;color:#d6a6ec}.gemini{background:#10325c;color:#86b7f5}
.muted{color:#73737f}
.disabled{opacity:.5}
.notice{background:#0c2e1f;border:1px solid #1c5c3e;border-radius:8px;padding:12px;margin:0 0 14px}
.notice code{display:block;background:#04140c;padding:8px 10px;border-radius:6px;margin-top:6px;word-break:break-all}
.danger{color:#f08a8a;border-color:#5c2a2a}
`;

const providerPills = (providers: CoarseProvider[]) =>
  providers.map((p) => html`<span class="pill ${p}">${p}</span>`);

const timeAgo = (iso?: string) => {
  if (!iso) return "never";
  return iso.slice(0, 10);
};

export const tokenRow = (r: Row) => {
  const expired = !!r.expiresAt && Date.parse(r.expiresAt) <= Date.now();
  return html`
	<tr id="tok-${r.hash}" class="${r.status === "disabled" || expired ? "disabled" : ""}">
		<td class="mono">${r.label || "(no label)"}</td>
		<td class="mono muted">…${r.last4}</td>
		<td>${providerPills(r.providers)}</td>
		<td class="muted">${r.status}</td>
		<td>${expired ? html`<span class="danger">expired</span>` : html`<span class="muted">${r.expiresAt ? r.expiresAt.slice(0, 10) : "never"}</span>`}</td>
		<td class="muted">${timeAgo(r.lastUsed)}</td>
		<td style="text-align:right;white-space:nowrap">
			<button
				class="ghost"
				hx-put="/admin/api/tokens/${r.hash}"
				hx-vals='{"status":"${r.status === "active" ? "disabled" : "active"}"}'
				hx-target="#tok-${r.hash}"
				hx-swap="outerHTML"
			>
				${r.status === "active" ? "disable" : "enable"}
			</button>
			<button
				class="ghost danger"
				hx-delete="/admin/api/tokens/${r.hash}"
				hx-target="#tok-${r.hash}"
				hx-swap="outerHTML"
				hx-confirm="Delete this token?"
			>
				delete
			</button>
		</td>
	</tr>`;
};

export const tokenTable = (rows: Row[]) => html`
	<table>
		<thead>
			<tr>
				<th>Label</th>
				<th>Token</th>
				<th>Providers</th>
				<th>Status</th>
				<th>Expires</th>
				<th>Last used</th>
				<th></th>
			</tr>
		</thead>
		<tbody>
			${rows.length ? rows.map(tokenRow) : html`<tr><td colspan="7" class="muted">No tokens yet.</td></tr>`}
		</tbody>
	</table>
`;

export const createdNotice = (token: string) => html`
	<div class="notice">
		Token created. Copy it now - it is shown only once:
		<code class="mono">${token}</code>
	</div>
`;

export const loginPage = () => html`<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width,initial-scale=1" />
			<title>api-proxy admin</title>
			<style>
				${raw(STYLE)}
			</style>
			<script src="${HTMX}"></script>
		</head>
		<body>
			<div class="wrap">
				<h1>api-proxy admin</h1>
				<div class="card">
					<h2>Sign in</h2>
					<form hx-post="/admin/login" hx-swap="none">
						<label for="password">Admin password</label>
						<input type="password" id="password" name="password" autocomplete="off" />
						<div style="margin-top:12px"><button type="submit">Sign in</button></div>
					</form>
				</div>
			</div>
		</body>
	</html>`;

export const dashboardPage = () => html`<!doctype html>
	<html lang="en">
		<head>
			<meta charset="utf-8" />
			<meta name="viewport" content="width=device-width,initial-scale=1" />
			<title>api-proxy admin</title>
			<style>
				${raw(STYLE)}
			</style>
			<script src="${HTMX}"></script>
		</head>
		<body>
			<div class="wrap">
				<h1>api-proxy admin</h1>
				<div class="card">
					<h2>Add token</h2>
					<form
						hx-post="/admin/api/tokens"
						hx-target="#created"
						hx-swap="innerHTML"
						hx-on::after-request="if(event.detail.successful) this.reset()"
					>
						<div class="row">
							<div>
								<label for="label">Label</label>
								<input type="text" id="label" name="label" placeholder="alice-laptop" />
							</div>
							<div>
								<label for="token">Token (blank = generate)</label>
								<input type="text" id="token" name="token" placeholder="auto" autocomplete="off" />
							</div>
							<div>
								<label for="expiresAt">Expires (optional)</label>
								<input type="datetime-local" id="expiresAt" name="expiresAt" />
							</div>
						</div>
						<div class="checks">
							<label><input type="checkbox" name="providers" value="openai" checked /> OpenAI</label>
							<label><input type="checkbox" name="providers" value="anthropic" /> Anthropic</label>
							<label><input type="checkbox" name="providers" value="gemini" /> Gemini</label>
						</div>
						<button type="submit">Add</button>
						<a class="ghost" href="/admin/logout" style="margin-left:10px;text-decoration:none">sign out</a>
					</form>
					<div id="created" style="margin-top:14px"></div>
				</div>
				<div class="card">
					<h2>Tokens</h2>
					<div id="tokens" hx-get="/admin/api/tokens" hx-trigger="load, tokens-changed from:body, every 10s">
						Loading…
					</div>
				</div>
			</div>
		</body>
	</html>`;
