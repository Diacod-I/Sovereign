// web/app/api/curation/route.ts
// The ids this marketplace will not serve, published so the MCP agrees with the
// website.
//
// sovereign-mcp reads the subgraph directly, which is the right default: it
// means discovery keeps working when this site is down. The cost is that it
// would happily offer a listing the marketplace has retired, so it asks here
// first. A short cache because this changes on deploys, not on requests.

import { HIDDEN_LISTINGS } from '../../lib/curation';

export const runtime = 'nodejs';

export async function GET() {
  return new Response(JSON.stringify({ hidden: HIDDEN_LISTINGS }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  });
}
