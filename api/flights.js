import { waitUntil } from '@vercel/functions'
import { handle } from '../server/api.js'

/* The whole flight-booking API (see server/api.js). vercel.json rewrites
   /api/flights/* here and allows up to 300 s, because TBO's Ticket call
   can take that long. */
const run = (request) => handle(request, waitUntil)

export const GET = run
export const POST = run
