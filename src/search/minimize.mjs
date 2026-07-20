import http from "node:http";

export function httpGet(url, timeoutMs = 1000) {
	return new Promise((resolve) => {
		const req = http.get(url, (res) => {
			let body = "";
			res.on("data", (d) => (body += d));
			res.on("end", () => resolve({ ok: res.statusCode === 200, body }));
		});
		req.on("error", () => resolve({ ok: false }));
		req.setTimeout(timeoutMs, () => {
			req.destroy();
			resolve({ ok: false });
		});
	});
}

export async function minimizeViaCDP(port) {
	try {
		const versionResponse = await httpGet(`http://localhost:${port}/json/version`);
		if (!versionResponse.ok) return;
		const version = JSON.parse(versionResponse.body);
		const targetsResponse = await httpGet(`http://localhost:${port}/json/list`);
		if (!targetsResponse.ok) return;
		const targets = JSON.parse(targetsResponse.body);
		const targetId = targets.find((t) => t.type === "page")?.id;
		if (!targetId) return;

		const wsUrlStr = version.webSocketDebuggerUrl;
		if (typeof wsUrlStr !== "string") return;
		const wsUrl = new URL(wsUrlStr);
		if (wsUrl.hostname !== "localhost" && wsUrl.hostname !== "127.0.0.1")
			return;
		if (!/^ws:\/\/localhost:\d+/.test(`ws://${wsUrl.host}`)) return;

		const ws = new WebSocket(`ws://localhost:${port}${wsUrl.pathname}`);
		await new Promise((resolve) => {
			let settled = false;
			const timeout = setTimeout(() => finish(), 5000);
			const finish = () => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				try {
					ws.close();
				} catch {}
				resolve();
			};

			ws.onopen = () => {
				try {
					ws.send(
						JSON.stringify({
							id: 1,
							method: "Browser.getWindowForTarget",
							params: { targetId },
						}),
					);
				} catch {
					finish();
				}
			};
			ws.onmessage = (ev) => {
				try {
					const msg = JSON.parse(ev.data);
					if (msg.id === 1 && msg.result?.windowId) {
						ws.send(
							JSON.stringify({
								id: 2,
								method: "Browser.setWindowBounds",
								params: {
									windowId: msg.result.windowId,
									bounds: { windowState: "minimized" },
								},
							}),
						);
					} else if (msg.id === 2) {
						finish();
					} else if (msg.id === 1) {
						finish();
					}
				} catch {
					finish();
				}
			};
			ws.onerror = finish;
		});
	} catch {
		// best-effort
	}
}
