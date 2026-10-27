#!/bin/sh
# create the owner user and finish onboarding; prints the token JSON
B=http://127.0.0.1:8123
CID=http://127.0.0.1:8123/
CODE=$(curl -s -X POST $B/api/onboarding/users -H 'Content-Type: application/json' \
  -d "{\"client_id\":\"$CID\",\"name\":\"Test\",\"username\":\"test\",\"password\":\"test-pass-1234\",\"language\":\"en\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["auth_code"])')
TOK=$(curl -s -X POST $B/auth/token -d "grant_type=authorization_code&code=$CODE&client_id=$CID")
AT=$(echo "$TOK" | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
for step in core_config analytics; do curl -s -o /dev/null -X POST $B/api/onboarding/$step -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d '{}'; done
curl -s -o /dev/null -X POST $B/api/onboarding/integration -H "Authorization: Bearer $AT" -H 'Content-Type: application/json' -d "{\"client_id\":\"$CID\",\"redirect_uri\":\"$CID\"}"
echo "$TOK"
