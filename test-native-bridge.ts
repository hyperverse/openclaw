import { callGateway } from "./src/gateway/call.js";
import { loadConfig } from "./src/config/config.js";

async function main() {
    const cfg = loadConfig();
    const result = await callGateway({
        method: "message.send",
        params: {
            to: "agent",
            channel: "agithon",
            message: "Hello from persistent Native Bridge!"
        },
        url: "ws://127.0.0.1:18790",
        token: "dev"
    });
    console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
