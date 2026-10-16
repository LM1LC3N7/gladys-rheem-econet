# Rheem EcoNet

Vos chauffe-eau et thermostats Rheem et Ruud dans Gladys, par le cloud EcoNet
(l'application EcoNet, États-Unis et Canada).

> **Jamais testé sur un vrai compte pour l'instant.** Cette première version
> a été écrite à partir de la bibliothèque libre pyeconet (celle de Home
> Assistant) et testée uniquement sur ses réponses d'exemple. Vos retours sur
> le forum sont les bienvenus. Non officiel, sans lien avec Rheem.

## Ce que vous obtenez

Chaque équipement de votre compte EcoNet est proposé dans l'onglet
**Découverte**, avec les fonctionnalités qu'il remonte.

**Chauffe-eau** (pompe à chaleur, électriques, gaz, instantanés) :

| Fonctionnalité                   | Ce que c'est                                                                                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mode                             | Les modes de votre appareil, avec leurs noms EcoNet : arrêt, économie d'énergie, pompe à chaleur seule, forte demande, électrique, gaz, performance, vacances. Dans les scènes, ce sont les modes chauffe-eau de Gladys (voir le tableau plus bas). |
| Consigne de l'eau                | En °F, dans les limites de l'appareil (souvent 110 à 140 °F).                                                                                                                                                                                       |
| Eau chaude disponible            | 0, 33, 66 ou 100 %, le niveau du ballon affiché par l'application (appareils qui le remontent).                                                                                                                                                     |
| Chauffe                          | 1 quand l'appareil chauffe.                                                                                                                                                                                                                         |
| Vanne d'arrêt                    | Ouverte (1) ou fermée (0), en lecture seule, quand une vanne est installée. Gladys ne l'ouvre ni ne la ferme jamais.                                                                                                                                |
| État de la cuve / du compresseur | 0 à 100 %, quand l'appareil le remonte.                                                                                                                                                                                                             |
| Énergie par jour                 | Les kWh consommés chaque jour, d'après le rapport d'énergie de l'application (appareils électriques et pompes à chaleur qui l'ont). Publiée le lendemain.                                                                                           |
| Alertes actives                  | Le nombre d'alertes qu'EcoNet affiche pour l'appareil (fuite, défaut…). Leur détail reste dans l'application.                                                                                                                                       |

Correspondance des modes EcoNet avec les modes de Gladys :

| EcoNet                          | Mode Gladys |
| ------------------------------- | ----------- |
| Off                             | Arrêt       |
| Energy Saver (pompe à chaleur)  | Auto        |
| Energy Saver (autres appareils) | Éco         |
| Heat Pump Only                  | Éco         |
| High Demand, Performance        | Boost       |
| Electric, Gas                   | Manuel      |
| Vacation                        | Absence     |

**Thermostats** (chaque zone d'un système multizone est un appareil) :

| Fonctionnalité                         | Ce que c'est                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------- |
| Température                            | La température de la pièce, en °F.                                                    |
| Humidité                               | En %, quand elle est remontée.                                                        |
| Consignes de chauffage / climatisation | En °F ; en mode auto elles gardent l'écart (zone neutre) que demande le thermostat.   |
| Mode                                   | Arrêt, chauffage, climatisation, auto.                                                |
| Mode EcoNet                            | Tous les modes du thermostat, ventilation seule et chauffage d'appoint compris.       |
| Fonctionnement                         | Au repos, chauffe ou climatise.                                                       |
| Vitesse de ventilation                 | Auto, basse, moyenne-basse, moyenne, moyenne-haute, haute, max (selon le thermostat). |
| Ventilation                            | Auto ou marche (continue), quand le thermostat a ce réglage.                          |
| Alertes actives                        | Comme pour les chauffe-eau.                                                           |

Les températures restent en °F, l'unité qu'EcoNet remonte (consignes en
degrés entiers, comme l'application les règle).

## Configuration

1. Dans l'onglet **Configuration**, saisissez l'**adresse e-mail** et le
   **mot de passe** de votre application EcoNet, puis enregistrez.
2. Utilisez **Tester la connexion** : il se connecte et liste vos équipements.
3. Ouvrez l'onglet **Découverte** et ajoutez les appareils voulus.

La **langue des noms de fonctionnalités** s'applique aux appareils découverts
ensuite.

## Fonctionnement

- Au démarrage, l'intégration se connecte, lit la liste des équipements du
  compte et ouvre le lien en direct (MQTT sur TLS, celui de l'application
  EcoNet) : les changements arrivent en quelques secondes, et les commandes
  passent par lui.
- Tout le compte est relu toutes les 30 minutes (toutes les 5 minutes quand
  le lien en direct est coupé), et l'énergie des derniers jours toutes les
  6 heures.
- Le badge d'un appareil indique **Cloud** ; avec un point orange quand le
  lien en direct est coupé (les états sont alors lus toutes les 5 minutes et
  les commandes indisponibles), **Injoignable** quand EcoNet signale
  l'appareil hors ligne ou ne répond pas.

## Limites

- Les commandes ont besoin du lien en direct : quand il est coupé, une
  commande est refusée avec un message.
- Un mot de passe refusé n'est jamais retenté tout seul (pour ménager votre
  compte) : corrigez-le puis enregistrez, ou appuyez sur **Tester la
  connexion** quand il fonctionne à nouveau.
- Pas encore pris en charge : l'absence et les vacances programmées, la
  reprise du programme, la consommation d'eau, le signal Wi-Fi, la consigne
  du déshumidificateur, le détail des alertes. Les appareils au gaz n'ont pas
  la fonctionnalité d'énergie (EcoNet la donne en kBTU).
- La consigne de l'eau n'est limitée que par l'appareil : au-delà de 120 °F
  (49 °C), l'eau chaude peut brûler. Pensez-y avant d'écrire des scènes.

## Confidentialité

Votre adresse e-mail et votre mot de passe ne sont envoyés qu'à EcoNet
(HTTPS), le jeton qu'EcoNet renvoie reste en mémoire et rien n'est écrit sur
le disque. Le mot de passe et le jeton n'apparaissent jamais dans les logs.

## Dépannage

- « EcoNet a refusé l'e-mail ou le mot de passe » : vérifiez-les dans
  l'application EcoNet.
- « les mises à jour en direct sont coupées » : l'intégration réessaie (10 s,
  puis plus longtemps, 5 minutes au plus). Les états continuent d'arriver
  toutes les 5 minutes.
- Une fonctionnalité manque : l'appareil est construit d'après ce que
  l'équipement remontait à sa découverte. Supprimez l'appareil et relancez
  une découverte après une mise à jour du micrologiciel.

Rheem, Ruud et EcoNet sont des marques de leurs propriétaires respectifs.
Cette intégration est non officielle et sans lien avec Rheem.
