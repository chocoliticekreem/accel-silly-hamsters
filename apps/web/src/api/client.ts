// The one switch between data sources: VITE_API_URL = the live backend; unset in a production build = the backend
// snapshot shipped in public/snapshot (api/snapshot.ts); unset in dev / tests = the mock.
import type { Api } from "./contract";
import { httpApi } from "./http";
import { installSnapshotFetch, SNAPSHOT_BASE } from "./snapshot";
import { mockApi } from "../mock";

const LIVE: string | undefined = import.meta.env.VITE_API_URL || undefined;
const SNAPSHOT = !LIVE && import.meta.env.PROD && import.meta.env.VITE_SNAPSHOT !== "0";
if (SNAPSHOT) installSnapshotFetch();

export const API_URL: string | undefined = LIVE ?? (SNAPSHOT ? SNAPSHOT_BASE : undefined);
export const USING_MOCK = !API_URL;

export const api: Api = API_URL ? httpApi(API_URL) : mockApi();
