/**
 * doctor staleness tests — pure unit tests over findStaleBoxes / normImageId.
 * No podman needed: the shell-out (podman ps / image inspect) is a thin wrapper
 * around this logic, which decides which running boxes are pinned to an image
 * other than the current `:dev` tag. See `claude-box doctor`.
 *
 *   nix run nixpkgs#bun -- test tests/doctor.test.ts
 */
import { test, expect } from "bun:test";
import {
  findStaleBoxes,
  normImageId,
  type RunningBox,
} from "../claude-box.ts";

const box = (id: string, imageId: string): RunningBox => ({
  id,
  imageId,
  status: "Up 1 hour",
});

test("normImageId strips the sha256: prefix", () => {
  expect(normImageId("sha256:8fcdb6301627")).toBe("8fcdb6301627");
  expect(normImageId("8fcdb6301627")).toBe("8fcdb6301627");
});

test("box on the current image is not stale", () => {
  const cur = "8fcdb6301627ca52883916d4af9e4213119b7a2d";
  const stale = findStaleBoxes([box("aaa", cur)], cur);
  expect(stale).toHaveLength(0);
});

test("box on a different image is stale", () => {
  const cur = "8fcdb6301627ca52883916d4af9e4213119b7a2d";
  const old = "c747aa528507aaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const stale = findStaleBoxes([box("aaa", old)], cur);
  expect(stale.map((b) => b.id)).toEqual(["aaa"]);
});

test("short vs long image id forms match (no false positive)", () => {
  // podman reports short ids in some columns, long in others; a prefix match
  // on either side means same image.
  const long = "8fcdb6301627ca52883916d4af9e4213119b7a2d";
  const short = "8fcdb6301627";
  expect(findStaleBoxes([box("a", short)], long)).toHaveLength(0);
  expect(findStaleBoxes([box("a", long)], short)).toHaveLength(0);
});

test("sha256: prefix on one side still matches", () => {
  const cur = "sha256:8fcdb6301627ca52883916d4af9e4213119b7a2d";
  const boxId = "8fcdb6301627";
  expect(findStaleBoxes([box("a", boxId)], cur)).toHaveLength(0);
});

test("mixed fleet: only the drifted boxes are flagged", () => {
  const cur = "8fcdb6301627ca52883916d4af9e4213119b7a2d";
  const boxes = [
    box("current-1", "8fcdb6301627"),
    box("stale-29h", "c747aa528507"),
    box("stale-6h", "5526422b53c9"),
    box("current-2", cur),
  ];
  const stale = findStaleBoxes(boxes, cur).map((b) => b.id);
  expect(stale.sort()).toEqual(["stale-29h", "stale-6h"]);
});

test("empty current id treats every box as stale (no baseline to trust)", () => {
  const boxes = [box("a", "8fcdb6301627"), box("b", "c747aa528507")];
  expect(findStaleBoxes(boxes, "")).toHaveLength(2);
});

test("box with empty image id is treated as stale", () => {
  const cur = "8fcdb6301627ca52883916d4af9e4213119b7a2d";
  expect(findStaleBoxes([box("a", "")], cur).map((b) => b.id)).toEqual(["a"]);
});

test("no running boxes → nothing stale", () => {
  expect(findStaleBoxes([], "8fcdb6301627")).toHaveLength(0);
});
