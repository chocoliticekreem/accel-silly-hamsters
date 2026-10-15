// The one switch between mock and real data: VITE_API_URL unset = mock.
import type { Api } from "./contract";
import { httpApi } from "./http";
import { mockApi } from "../mock";

export const API_URL: string | undefined = import.meta.env.VITE_API_URL || undefined;
export const USING_MOCK = !API_URL;

export const api: Api = API_URL ? httpApi(API_URL) : mockApi();
