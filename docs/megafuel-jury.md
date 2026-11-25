# Démo jury — prolonger ou recharger MegaFuel

**Le sponsoring LeashPay sur BSC testnet expire vendredi 27 novembre 2026 à 09 h 00 en Thaïlande** (Bangkok, UTC+7, soit 02 h 00 UTC). NodeReal a confirmé cette échéance le 26 novembre. MegaFuel prend en charge les frais réseau de l’agent à partir du crédit en tBNB de la politique **LeashPay BSC Testnet Hackathon**.

## Avant de passer devant le jury

Depuis la racine du dépôt, lancer `make megafuel-status`. La commande affiche la date de fin en heure de Bangkok, si le sponsoring est activé et dans sa période de validité, le solde disponible et le wallet de recharge. Elle utilise `NODEREAL_API_KEY` et `MEGAFUEL_POLICY_ID` du `.env` local. Elle se termine après la lecture.

| Ce que tu vois | Que faire |
|---|---|
| La politique couvre toute la présentation et le crédit est positif | Le sponsoring est prêt côté dates et solde. Vérifier que la clé de l’agent correspond au wallet autorisé. |
| La présentation finit après la date affichée | Prolonger la date en suivant la procédure ci-dessous. Le solde existant reste utilisable. |
| La date est bonne mais le crédit est épuisé | Recharger en tBNB depuis le wallet enregistré, puis vérifier le nouveau solde. |
| Le statut est désactivé malgré des dates valides, ou une transaction reste refusée | Ouvrir la politique dans MegaFuel. Vérifier son activation, la liste des expéditeurs autorisés et les plafonds. Un dépôt supplémentaire conserve les limites existantes. |

## Prolonger pour un autre créneau

Choisir l’heure à laquelle **la présentation doit finir**, en heure thaïlandaise. Par exemple, **uniquement si le jury est prévu jusqu’à midi le 27 novembre**, exécuter :

```sh
make megafuel-extend UNTIL='2026-11-27T12:00:00+07:00'
make megafuel-status
```

Remplacer la date et l’heure de l’exemple par le créneau réel. La commande modifie uniquement la fin de la politique et relit le résultat chez NodeReal. Vérifier la ligne `End (Bangkok)` et le statut affiché. L’alternative dans le [dashboard NodeReal](https://dashboard.nodereal.io/megafuel) est d’ouvrir **LeashPay BSC Testnet Hackathon**, modifier la date de fin, enregistrer, puis contrôler avec `make megafuel-status`. [Référence de mise à jour NodeReal](https://docs.nodereal.io/reference/pm-updatepolicy)

## Recharger le crédit de gas

1. Dans le [dashboard MegaFuel](https://dashboard.nodereal.io/megafuel), ouvrir **LeashPay BSC Testnet Hackathon** et afficher les instructions de dépôt pour **BSC testnet, chaîne 97**. Copier l’adresse de réception indiquée pour ce réseau.
2. Utiliser comme **expéditeur** le wallet affiché par `make megafuel-status` à la ligne `Registered funding wallet`. Pour LeashPay, c’est actuellement le déployeur `0x9B3f81b1B6E8baecAbD47698A46Fa3684834A7c2`. Depuis ce wallet sur la chaîne 97, envoyer le montant souhaité en **tBNB** à l’adresse de réception MegaFuel. Le wallet agent et la factory ne sont pas les destinataires du dépôt.
3. Conserver le hash du transfert, attendre la confirmation puis relancer `make megafuel-status`. Le solde doit augmenter. Si le dépôt n’apparaît pas, vérifier le réseau, l’expéditeur et le hash dans le dashboard avant de renvoyer des fonds. [Guide officiel des dépôts](https://docs.nodereal.io/docs/megafuel-sponsor-guidelines)

Pour la démo du coffre, `make start` lance séparément le relais de prix Atlas dans le terminal. Attendre le contrôle des deux flux, puis garder ce terminal ouvert pendant la présentation. `Ctrl-C` l’arrête.
