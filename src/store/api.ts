import { createApi, fakeBaseQuery } from "@reduxjs/toolkit/query/react";
import type { Evidence, PersistedStaging } from "../types";

const KEY = "pair-wise-yf-49/court";

interface CourtBlob {
  evidence: Evidence[];
  staging: PersistedStaging | null;
}

function readBlob(): CourtBlob {
  const raw = localStorage.getItem(KEY);
  if (!raw) return { evidence: [], staging: null };
  const parsed = JSON.parse(raw);
  // 兼容旧格式：直接存 evidence 数组
  if (Array.isArray(parsed)) return { evidence: parsed, staging: null };
  return { evidence: parsed.evidence ?? [], staging: parsed.staging ?? null };
}

export const courtApi = createApi({
  reducerPath: "courtApi",
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getCourt: builder.query<CourtBlob, void>({
      queryFn: async () => ({ data: readBlob() })
    }),
    saveCourt: builder.mutation<{ ok: true }, CourtBlob>({
      queryFn: async (payload) => {
        localStorage.setItem(KEY, JSON.stringify(payload));
        return { data: { ok: true } };
      }
    })
  })
});

export const { useGetCourtQuery, useSaveCourtMutation } = courtApi;
