import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Augment Lab GUI", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Augment Lab/);
  assert.match(html, /Choose dataset folder/);
  assert.match(html, /YOLO dataset studio/);
  assert.match(html, /Local processing only/);
  assert.doesNotMatch(html, /codex-preview|SkeletonPreview/);
});

test("keeps processing local and annotation-aware", async () => {
  const page = await readFile(new URL("../app/page.tsx", import.meta.url), "utf8");

  assert.match(page, /showDirectoryPicker/);
  assert.match(page, /function transformBoxes/);
  assert.match(page, /function parseYoloLabels/);
  assert.match(page, /"bbox" \| "obb"/);
  assert.match(page, /OBB corners/);
  assert.match(page, /getDirectoryHandle\(outputName, \{ create: true \}\)/);
  assert.match(page, /Your original dataset is never changed/);
  assert.doesNotMatch(page, /\bfetch\s*\(/);
  assert.doesNotMatch(page, /XMLHttpRequest|WebSocket/);
});
