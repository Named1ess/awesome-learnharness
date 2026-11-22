import concurrently from "concurrently";

const { result } = concurrently([
	"npm run dev",
	{ command: "electron .", env: { LH_DEV_URL: "http://localhost:3000" } },
], { killOthersOn: ["success", "failure"] });

try {
	await result;
} catch {
	process.exitCode = 1;
}
