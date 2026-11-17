import { loadRouteStatsFromDb } from "../lib/db.ts";
import { clampStatsHours, histogramPercentile, histogramTotal, mergeHistograms } from "../../lib/percentile.mjs";

export const runtime = "nodejs";

// 라우트 레이턴시 백분위. 이 엔드포인트는 절대 500을 내지 않는다 — 통계 테이블은 SDK가
// 채우는 부가 데이터라, DB 미설정·테이블 없음(ER_NO_SUCH_TABLE)·행 0건은 전부 "아직
// 없음"이지 장애가 아니다. 호출부(트레이스 상세 배지)는 available:false면 배지를 숨긴다.
export async function GET(request: Request) {
  const url = new URL(request.url);
  const service = url.searchParams.get("service")?.trim();
  const route = url.searchParams.get("route")?.trim();
  const hours = clampStatsHours(url.searchParams.get("hours"));

  if (!service || !route) {
    return Response.json({ available: false });
  }

  try {
    const rows = await loadRouteStatsFromDb(service, route, hours);
    if (!rows?.length) {
      return Response.json({ available: false });
    }
    const histogram = mergeHistograms(rows.map(row => row.histogram));
    const count = histogramTotal(histogram);
    if (count <= 0) {
      return Response.json({ available: false });
    }
    return Response.json({
      available: true,
      count,
      // 마지막 버킷(30s)을 넘긴 백분위는 상한이 없어 null로 내보낸다. count > 0이므로
      // 여기서의 null은 "표본 없음"이 아니라 항상 "30s 초과"를 뜻한다.
      p50: jsonMs(histogramPercentile(histogram, 0.5)),
      p95: jsonMs(histogramPercentile(histogram, 0.95)),
      p99: jsonMs(histogramPercentile(histogram, 0.99)),
      // 병합 histogram도 같이 내보낸다 — 배지의 "상위 n%"는 이벤트마다 durationMs가 달라
      // 클라이언트가 histogramRank로 직접 계산해야 하고, 그래야 응답이 (service, route)
      // 단위로 캐시된 채 상세 열람당 1회 요청으로 끝난다. 15칸이라 크기는 무시할 수준.
      histogram
    });
  } catch (error) {
    console.warn("Route stats unavailable", error);
    return Response.json({ available: false });
  }
}

function jsonMs(value: number | null): number | null {
  return value != null && Number.isFinite(value) ? Math.round(value) : null;
}
