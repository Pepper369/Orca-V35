import { GET as hourlyGET, POST as hourlyPOST } from "../hourly-update/route";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  return hourlyGET(request);
}

export async function POST(request: Request) {
  return hourlyPOST(request);
}
