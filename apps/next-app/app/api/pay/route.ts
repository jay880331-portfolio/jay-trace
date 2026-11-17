export async function POST(request: Request) {
  const backend = process.env.JAYTRACE_BACKEND_URL ?? "http://localhost:3012";
  const response = await fetch(`${backend}/api/pay`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      traceparent: request.headers.get("traceparent") ?? ""
    }
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") ?? "application/json"
    }
  });
}
