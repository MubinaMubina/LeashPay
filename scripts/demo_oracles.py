"""Live, read-only CoinMarketCap and Cournot checks for the terminal demo."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from urllib.parse import urlsplit

import requests


COURNOT_ORIGIN = "https://interface.cournot.ai"
# Match the underlying event. Cournot issues the usable market ID during resolution.
DEPEG_QUESTION = (
    "Will USDC depeg below $0.98 for 24 consecutive hours by December 31, 2026?"
)


def request_json(provider, method, url, *, timeout, **kwargs):
    try:
        response = requests.request(method, url, allow_redirects=False, timeout=timeout, **kwargs)
    except requests.RequestException:
        raise RuntimeError(f"{provider} injoignable. Vérifier le réseau et l’accès à son API.") from None
    if response.status_code == 402 and provider == "Cournot":
        raise RuntimeError("Cournot exige un paiement (HTTP 402). Vérifier le quota ou renseigner "
                           "COURNOT_API_KEY avec un accès déjà crédité.")
    if not 200 <= response.status_code < 300:
        hint = {401: "Vérifier la clé API.", 403: "Vérifier les droits d’accès.",
                429: "Limite de requêtes atteinte."}.get(response.status_code, "Vérifier le service.")
        raise RuntimeError(f"{provider} a répondu HTTP {response.status_code}. {hint}")
    try:
        payload = response.json()
    except ValueError:
        payload = None
    if not isinstance(payload, dict):
        raise RuntimeError(f"{provider} a renvoyé une réponse JSON illisible.")
    return payload


def number(value, error):
    try:
        result = Decimal(str(value))
    except InvalidOperation:
        raise RuntimeError(error) from None
    if not result.is_finite():
        raise RuntimeError(error)
    return result


def utc(value, error):
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if stamp.tzinfo is not None:
            return stamp.astimezone(timezone.utc)
    except (AttributeError, TypeError, ValueError, OverflowError):
        pass
    raise RuntimeError(error)


def cmc(env):
    key = env.get("CMC_API_KEY")
    if not key:
        raise RuntimeError("Renseigner CMC_API_KEY dans .env pour interroger CoinMarketCap Pro.")
    headers = {"Accept": "application/json", "X-CMC_PRO_API_KEY": key}
    payload = request_json("CoinMarketCap", "GET", "https://pro-api.coinmarketcap.com/v3/cryptocurrency/quotes/latest",
                           params={"id": "825", "convert": "PHP"}, headers=headers, timeout=20)
    status = payload.get("status")
    if not isinstance(status, dict) or str(status.get("error_code")) != "0":
        raise RuntimeError("CoinMarketCap a refusé la cotation. Vérifier le quota et les droits API.")
    try:
        asset = next(a for a in payload["data"] if a["id"] == 825 and a["symbol"] == "USDT")
        quote = next(q for q in asset["quote"] if q["symbol"] == "PHP")
        price = number(quote["price"], "Prix CoinMarketCap invalide.")
        stamp = utc(quote["last_updated"], "Horodatage CoinMarketCap invalide.")
    except (KeyError, TypeError, StopIteration):
        raise RuntimeError("CoinMarketCap n’a pas fourni la cotation USDT (825) en PHP.") from None
    if price <= 0:
        raise RuntimeError("Prix CoinMarketCap invalide.")
    age = datetime.now(timezone.utc) - stamp
    if not -timedelta(minutes=2) <= age <= timedelta(minutes=15):
        raise RuntimeError("Cotation CoinMarketCap hors de la fenêtre de fraîcheur de la démo (15 min).")
    print(f"✓ CoinMarketCap · 1 USDT = {price:.4f} PHP · cours du {stamp:%Y-%m-%d %H:%M:%S} UTC")
    print("  ID CMC 825 · https://coinmarketcap.com/currencies/tether/")


def cournot_data(operation, body, key=None):
    payload = request_json("Cournot", "POST", f"{COURNOT_ORIGIN}/intelligence/v1/{operation}",
                           json=body, headers={"COURNOT-API-KEY": key} if key else {},
                           timeout=120 if operation == "probability" else 30)
    code = payload.get("code")
    if code == 22002:
        raise RuntimeError("Crédits Cournot épuisés. Vérifier le solde de la clé.")
    if type(code) is not int or code != 0 or not isinstance(payload.get("data"), dict):
        public_code = str(code) if type(code) is int else "inconnu"
        raise RuntimeError(f"Cournot a refusé {operation} (code {public_code}). Vérifier l’accès au marché.")
    return payload["data"]


def sources_in(basis):
    """Basis can be an array of sources or a structured anchor plus cross-checks."""
    if isinstance(basis, list):
        for item in basis:
            yield from sources_in(item)
    elif isinstance(basis, dict):
        label = basis.get("source")
        url = basis.get("url")
        if isinstance(label, str) and label.strip() and label.isprintable():
            if basis.get("time"):
                stamp = utc(basis["time"], "Horodatage de source Cournot invalide.")
                label = f"{label} · {stamp:%Y-%m-%d %H:%M:%S} UTC"
            if isinstance(url, str) and url.isprintable():
                try:
                    parts = urlsplit(url)
                    if parts.scheme in ("http", "https") and parts.hostname and not parts.username:
                        yield f"{label} · {url}"
                        return
                except ValueError:
                    pass
            yield label
        for item in basis.values():
            yield from sources_in(item)


def cournot(env):
    for name in ("COURNOT_API_URL", "COURNOT_API_BASE", "COURNOT_API_KEY_BASE"):
        if (env.get(name) or COURNOT_ORIGIN).rstrip("/") != COURNOT_ORIGIN:
            raise RuntimeError(f"Vérifier {name}. Cette démo utilise uniquement {COURNOT_ORIGIN}.")
    error = "DEPEG_THRESHOLD_PCT doit être un pourcentage entre 0 et 100."
    threshold = number(env.get("DEPEG_THRESHOLD_PCT", "5"), error)
    if not 0 <= threshold <= 100:
        raise RuntimeError(error)
    resolved = cournot_data("resolve", {"message": DEPEG_QUESTION, "limit": 5})
    try:
        matches = []
        for entry in resolved["markets"]:
            market = entry["market_info"]
            description = market["description"].lower()
            if (market["title"] == "USDC depeg by December 31?" and market["market_outcome"] == "YES"
                    and "24-hour period" in description and "below 98 cents" in description
                    and utc(market["end_time"], "Échéance Cournot invalide.") ==
                    datetime(2027, 1, 1, 5, tzinfo=timezone.utc)):
                matches.append(market)
        market, = matches
        market_id = str(market["id"])
        title = market["title"]
        end = utc(market["end_time"], "Échéance Cournot manquante.")
    except (KeyError, TypeError, AttributeError, ValueError):
        raise RuntimeError("Cournot n’a pas identifié un marché unique de décrochage USDC. "
                           "Vérifier le marché actif avant de choisir une devise.") from None
    if not market_id.isascii() or not market_id.isdecimal():
        raise RuntimeError("Identifiant du marché Cournot invalide.")
    if end <= datetime.now(timezone.utc):
        raise RuntimeError("Marché de décrochage USDC expiré. Sélectionner un marché Cournot actif.")

    data = cournot_data("probability", {"message": DEPEG_QUESTION, "market_ids": [market_id]},
                        env.get("COURNOT_API_KEY"))
    if "markets" in data:
        try:
            assessed_market, = data["markets"]
            matches_request = str(assessed_market["market_info"]["id"]) == market_id
        except (TypeError, ValueError, KeyError):
            matches_request = False
        if not matches_request:
            raise RuntimeError("La réponse Cournot ne correspond pas au marché demandé.")
    # The API currently returns a numeric probability. Richer assessments put
    # the estimate under result.point_estimate and may nest their basis too.
    probability = data.get("probability")
    assessment = probability if isinstance(probability, dict) else data
    result = assessment.get("result")
    raw = result.get("point_estimate") if isinstance(result, dict) else probability
    estimate = number(raw, "Probabilité Cournot absente ou invalide.")
    if not 0 <= estimate <= 1:
        raise RuntimeError("Probabilité Cournot hors limites.")
    sources = list(dict.fromkeys(sources_in(assessment.get("basis", data.get("basis")))))
    if not sources:
        raise RuntimeError("Cournot n’a fourni aucune source identifiable pour cette estimation.")
    percent = estimate * 100
    token = "USDT" if percent > threshold else "USDC"
    print(f"✓ Cournot · marché {market_id} · {title}")
    print(f"  Décrochage USDC sous 0,98 USD pendant 24 h · échéance {end:%Y-%m-%d %H:%M} UTC")
    print(f"  Probabilité Cournot · {percent.normalize():f} %")
    for source in sources:
        print(f"  Source · {source}")
    print(f"✓ Choix LeashPay (démo) · bascule si le risque dépasse {threshold:f} % → {token}")
    for route, field, caption in (("free_quota", "free_quota", "gratuites"),
                                  ("api_key", "api_key_quota", "prépayées")):
        quota = data.get(field)
        if data.get("billing") == route and isinstance(quota, dict) and type(quota.get("remaining")) is int:
            print(f"  Consultations Cournot {caption} restantes · {quota['remaining']}")
