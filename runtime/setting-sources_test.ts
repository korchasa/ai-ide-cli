import { assertThrows } from "@std/assert";
import {
  type SettingSource,
  validateSettingSources,
} from "./setting-sources.ts";

Deno.test("FR-L18 validateSettingSources accepts every known source, [] and undefined", () => {
  validateSettingSources(["user", "project", "local"]);
  validateSettingSources([]);
  validateSettingSources(undefined);
});

Deno.test("FR-L18 validateSettingSources rejects an unknown source", () => {
  assertThrows(
    () => validateSettingSources(["user", "User" as SettingSource]),
    Error,
    'unknown source "User"; valid: user, project, local',
  );
});
