import type { MetadataRoute } from "next";
import { API_BASE, engineHeaders } from "@/lib/api";

const SITE = process.env.SITE_URL ?? "http://localhost:3000";
const CHUNK = 5000;

async function chunkCount(): Promise<number> {
  try {
    const res = await fetch(`${API_BASE}/api/sitemap?chunk=0&size=${CHUNK}`, {
      headers: engineHeaders(),
    });
    if (!res.ok) return 1;
    const { chunks } = (await res.json()) as { chunks: number };
    return Math.max(chunks, 1);
  } catch {
    return 1;
  }
}

/** ~20k HTS pages are chunked so each sitemap file stays small enough to
 *  regenerate cheaply as rates change. */
export async function generateSitemaps() {
  const n = await chunkCount();
  return Array.from({ length: n }, (_, i) => ({ id: i }));
}

export default async function sitemap({
  id,
}: {
  // Next 16 hands the generated id back as a promise, the same as route params.
  id: Promise<number | string> | number | string;
}): Promise<MetadataRoute.Sitemap> {
  const chunk = Number(await id) || 0;

  const staticPages: MetadataRoute.Sitemap =
    chunk === 0
      ? ["", "/classify", "/calculator", "/changes", "/audit", "/china-tariffs", "/pricing", "/docs/api"].map((p) => ({
          url: `${SITE}${p}`,
          changeFrequency: "daily" as const,
          priority: p === "" ? 1 : 0.8,
        }))
      : [];

  try {
    const res = await fetch(`${API_BASE}/api/sitemap?chunk=${chunk}&size=${CHUNK}`, {
      headers: engineHeaders(),
      next: { revalidate: 86400 },
    });
    if (!res.ok) return staticPages;
    const { codes } = (await res.json()) as { codes: string[] };
    return [
      ...staticPages,
      ...codes.map((c) => ({
        url: `${SITE}/hts/${c}`,
        changeFrequency: "weekly" as const,
        priority: 0.6,
      })),
    ];
  } catch {
    return staticPages;
  }
}
