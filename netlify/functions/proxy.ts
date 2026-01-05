import { Context } from "@netlify/edge-functions";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "*",
  "access-control-allow-headers": "*",
};

const REQUEST_TIMEOUT = 20000;
const MAX_RETRIES = 2;
const RETRY_DELAY = 1000;

const BLOCKED_HEADERS = [
  "cookie",
  "set-cookie",
  "host",
  "referer",
  "user-agent",
  "x-forwarded-for",
  "x-real-ip",
  "x-forwarded-host",
  "x-forwarded-proto"
];

const pickHeaders = (headers: Headers, blockedKeys: string[]): Headers => {
  const picked = new Headers();
  for (const key of headers.keys()) {
    const lowerKey = key.toLowerCase();
    if (!blockedKeys.includes(lowerKey)) {
      const value = headers.get(key);
      if (typeof value === "string") {
        picked.set(key, value);
      }
    }
  }
  return picked;
};

const addProxyHeaders = (headers: Headers, request: Request): void => {
  headers.set("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36");
  headers.set("accept", "application/json, text/plain, */*");
  headers.set("accept-language", "en-US,en;q=0.9");
  headers.set("accept-encoding", "gzip, deflate, br");
  headers.set("cache-control", "no-cache");
  headers.set("pragma", "no-cache");
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const fetchWithTimeout = async (url: URL, options: RequestInit, timeout: number): Promise<Response> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url.toString(), {
      ...options,
      signal: controller.signal,
      //@ts-ignore
      duplex: "half",// netlify need half duplex
    });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    throw error;
  }
};

const fetchWithRetry = async (url: URL, options: RequestInit, retries: number = MAX_RETRIES): Promise<Response> => {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fetchWithTimeout(url, options, REQUEST_TIMEOUT);
    } catch (error) {
      lastError = error as Error;
      console.error(`Attempt ${attempt + 1} failed:`, error);
      
      if (attempt < retries) {
        await sleep(RETRY_DELAY * (attempt + 1));
      }
    }
  }
  
  throw lastError;
};

export default async (request: Request, context: Context) => {

  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: CORS_HEADERS,
    });
  }

  const { pathname, searchParams } = new URL(request.url);

  const url = new URL(pathname, "https://generativelanguage.googleapis.com");
  searchParams.delete("_path");
  searchParams.forEach((value, key) => url.searchParams.append(key, value));

  const headers = pickHeaders(request.headers, BLOCKED_HEADERS);
  addProxyHeaders(headers, request);

  try {
    const response = await fetchWithRetry(url, {
      body: request.body,
      method: request.method,
      headers,
    });

    const responseHeaders = {
      ...CORS_HEADERS,
      ...Object.fromEntries(response.headers),
    };

    return new Response(response.body, {
      headers: responseHeaders,
      status: response.status
    });
  } catch (error) {
    console.error("Proxy error:", error);
    
    return new Response(
      JSON.stringify({
        error: "Proxy request failed",
        message: error instanceof Error ? error.message : "Unknown error"
      }),
      {
        status: 502,
        headers: {
          ...CORS_HEADERS,
          "content-type": "application/json"
        }
      }
    );
  }
};
