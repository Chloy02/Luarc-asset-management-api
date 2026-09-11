import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const fixtures = JSON.parse(open('./fixtures.json'));
const BASE = __ENV.BASE_URL || 'http://localhost:3000';

export const options = {
  scenarios: {
    race: { executor: 'per-vu-iterations', vus: fixtures.tokens.length, iterations: 1, maxDuration: '2m' },
  },
  thresholds: {
    server_errors: ['count==0'],
    http_req_duration: ['p(95)<1000'],
  },
};

const claimed = new Counter('claims_201');
const soldOut = new Counter('claims_410');
const duplicate = new Counter('claims_409');
const serverErrors = new Counter('server_errors');

export default function () {
  const token = fixtures.tokens[__VU - 1];
  const res = http.post(`${BASE}/coupons/${fixtures.coupon_id}/claims`, null, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 201) claimed.add(1);
  else if (res.status === 410) soldOut.add(1);
  else if (res.status === 409) duplicate.add(1);
  else serverErrors.add(1);
  check(res, { 'no 5xx': (r) => r.status < 500 });
}

export function teardown() {
  const res = http.get(`${BASE}/coupons/${fixtures.coupon_id}`, {
    headers: { Authorization: `Bearer ${fixtures.tokens[0]}` },
  });
  const body = JSON.parse(res.body);
  console.log(`claimed_count=${body.claimed_count} total_quantity=${body.total_quantity} remaining=${body.remaining}`);
  if (body.claimed_count !== fixtures.units) {
    throw new Error(`INVARIANT VIOLATED: claimed_count ${body.claimed_count} != units ${fixtures.units}`);
  }
}
