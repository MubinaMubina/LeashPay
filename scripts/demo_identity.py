"""Live Living Brain memory and Privy authentication checks for the LeashPay demo."""
import hashlib
import re
import time
from urllib.parse import quote
from uuid import uuid4

import jwt
import requests


def required(env, name):
    if not env.get(name):
        raise RuntimeError(f"Renseigner {name} dans l’environnement de démonstration.")
    return env[name]


def request(label, method, url, *, allow_empty=False, **kwargs):
    try:
        res = requests.request(method, url, timeout=15, allow_redirects=False, **kwargs)
        if res.status_code == 402 and "prepaid memory balance is too low" in res.text:
            raise RuntimeError("Living Brain refuse la capture (HTTP 402, solde prépayé insuffisant). "
                               "Vérifier le crédit mémoire du compte de démonstration.")
        if not 200 <= res.status_code < 300:
            raise RuntimeError(f"{label} a répondu HTTP {res.status_code}. Vérifier l’accès au service.")
        if allow_empty and not res.content:
            return {}
        return res.json()
    except requests.ConnectionError:
        raise RuntimeError(f"{label} est injoignable. Vérifier la connexion au service.") from None
    except (requests.RequestException, ValueError):
        raise RuntimeError(f"{label} n’a pas renvoyé de réponse JSON exploitable.") from None


def find_preference(base, headers, row, marker, preference):
    hits = request("La recherche Living Brain", "POST", base + "/search",
                   headers=headers, json={"query": marker, "topK": 8})
    if not isinstance(hits, list) or not isinstance(row.get("affectedPageIds"), list):
        raise RuntimeError("Living Brain a renvoyé une liste de pages illisible.")
    for hit in hits:
        if not isinstance(hit, dict) or hit.get("pageId") not in row["affectedPageIds"]:
            continue
        slug = hit.get("slug")
        if not isinstance(slug, str) or not slug:
            continue
        page = request("La page Living Brain", "GET", base + "/pages/" + quote(slug, safe=""),
                       headers=headers)
        if not isinstance(page, dict) or (page.get("id"), page.get("brainId"), page.get("subjectId")) != (
                hit["pageId"], row["brainId"], row["subjectId"]):
            raise RuntimeError("La page trouvée ne correspond pas à la capture de démonstration.")
        fields = [page.get(k) for k in ("title", "summary", "body")]
        text = " ".join(field for field in fields if isinstance(field, str))
        if marker in text and preference in text:
            return True
    return False


def brain(env):
    brain_id = required(env, "LIVING_BRAIN_BRAIN_ID")
    subject = required(env, "LIVING_BRAIN_SUBJECT_ID")
    headers = {"x-subject-id": subject, "x-api-key": required(env, "LIVING_BRAIN_API_KEY")}
    base = "https://api.livingbrain.com/v1/brains/" + quote(brain_id, safe="")
    marker = "LPDEMO" + uuid4().hex[:16].upper()
    preference = "PAYREF" + uuid4().hex[:10].upper()
    origin = "leashpay-demo:" + marker
    content = (f"LeashPay demo only. Recipient {marker} prefers the exact payout reference "
               f"{preference} on every payment receipt.")
    note = {"kind": "note", "label": f"LeashPay demo preference for {marker}",
            "content": content, "originRef": origin, "bucket": "notes"}
    capture = request("La capture Living Brain", "POST", base + "/captures", headers=headers, json=note)
    if not isinstance(capture, dict) or not isinstance(capture.get("id"), str) or not capture["id"]:
        raise RuntimeError("Living Brain n’a pas confirmé l’identifiant de la capture.")
    source_id = capture["id"]
    expected = dict(id=source_id, brainId=brain_id, subjectId=subject, originRef=origin, content=content)
    deadline = time.monotonic() + 120
    while True:
        feed = request("La lecture de la capture Living Brain", "GET", base + "/sources",
                       headers=headers, params={"ids": source_id})
        rows = feed.get("items") if isinstance(feed, dict) else None
        if not isinstance(rows, list):
            raise RuntimeError("Living Brain a renvoyé une liste de captures illisible.")
        row = next((item for item in rows if isinstance(item, dict) and item.get("id") == source_id), None)
        if row and any(row.get(k) != v for k, v in expected.items()):
            raise RuntimeError("La capture relue diffère de la préférence envoyée à Living Brain.")
        if row and row.get("status") == "failed":
            raise RuntimeError(f"Living Brain a reçu {marker}, puis a échoué à compiler sa page.")
        if row and row.get("status") == "completed" and find_preference(base, headers, row, marker, preference):
            print(f"✓ Living Brain · bénéficiaire de démo {marker} retrouvé · référence préférée {preference}")
            return
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Capture {marker} reçue. La recherche n’a pas confirmé la préférence sous 120 s.")
        time.sleep(3)


def wallet_label(base, headers, app_id, secret, user_id):
    if not secret:
        return "renseigner PRIVY_APP_SECRET pour consulter le wallet associé"
    user = request("La lecture du compte Privy", "GET", base + "/users/" + quote(user_id, safe=""),
                   headers=headers, auth=(app_id, secret))
    if not isinstance(user, dict) or user.get("id") != user_id or not isinstance(user.get("linked_accounts"), list):
        raise RuntimeError("Privy n’a pas confirmé les comptes associés à la session vérifiée.")
    for account in user["linked_accounts"]:
        if not isinstance(account, dict) or (account.get("type"), account.get("chain_type")) != ("wallet", "ethereum"):
            continue
        address = account.get("address")
        if not isinstance(address, str) or not re.fullmatch(r"0x[\da-fA-F]{40}", address, re.ASCII):
            raise RuntimeError("Le wallet EVM du compte Privy porte une adresse illisible.")
        return f"wallet {address[:6]}…{address[-4:]}"
    return "aucun wallet EVM associé"


def privy(env):
    app_id = required(env, "NEXT_PUBLIC_PRIVY_APP_ID")
    base = "https://api.privy.io/v1"
    app_url = base + "/apps/" + quote(app_id, safe="")
    headers = {"privy-app-id": app_id, "User-Agent": "LeashPay-Demo/1.0"}
    app = request("L’application Privy", "GET", app_url, headers=headers)
    if not isinstance(app, dict) or app.get("id") != app_id or not app.get("verification_key"):
        raise RuntimeError("Vérifier NEXT_PUBLIC_PRIVY_APP_ID et la clé de vérification de l’application Privy.")
    token = env.get("PRIVY_ACCESS_TOKEN")
    test_account = not token
    if test_account:
        if not env.get("PRIVY_APP_SECRET"):
            raise RuntimeError("Privy est joignable. Renseigner PRIVY_APP_SECRET pour le compte de test "
                               "ou PRIVY_ACCESS_TOKEN pour une session ouverte.")
        auth = (app_id, env["PRIVY_APP_SECRET"])
        creds = request("Le compte de test Privy", "GET", app_url + "/test_credentials",
                        headers=headers, auth=auth, allow_empty=True)
        accounts = creds.get("data") if isinstance(creds, dict) else None
        if not accounts:
            raise RuntimeError("Privy est joignable. Pour ouvrir une session de test, activer "
                               "« Enable test accounts » dans User management > Authentication > Advanced "
                               "ou fournir PRIVY_ACCESS_TOKEN depuis une session LeashPay.")
        account = accounts[0] if isinstance(accounts, list) else None
        if not isinstance(account, dict) or not account.get("email") or not account.get("otp_code"):
            raise RuntimeError("Vérifier les identifiants du compte de test dans le tableau de bord Privy.")
        login = request("La connexion du compte de test Privy", "POST", base + "/passwordless/authenticate",
                        headers=headers, auth=auth, json={"email": account["email"], "code": account["otp_code"]})
        token = login.get("token") if isinstance(login, dict) else None
    try:
        if not token or jwt.get_unverified_header(token).get("typ") != "JWT":
            raise ValueError
        claims = jwt.decode(token, app["verification_key"], algorithms=["ES256"],
                            issuer="privy.io", audience=app_id,
                            options={"require": ["iss", "aud", "exp", "iat", "sid", "sub"], "strict_aud": True})
        if (not isinstance(claims["sid"], str) or not claims["sid"] or
                not claims["sub"].startswith("did:privy:") or claims["sub"] == "did:privy:"):
            raise ValueError
    except (jwt.PyJWTError, ValueError, TypeError, OverflowError):
        raise RuntimeError("Le jeton de session Privy est invalide ou expiré. "
                           "Se reconnecter au compte de démonstration.") from None
    fingerprint = hashlib.sha256(claims["sid"].encode()).hexdigest()[:12]
    wallet = wallet_label(base, headers, app_id, env.get("PRIVY_APP_SECRET"), claims["sub"])
    label = "compte de test" if test_account else "compte utilisateur"
    print(f"✓ Privy · session du {label} vérifiée par signature ES256 · empreinte {fingerprint} · {wallet}")
