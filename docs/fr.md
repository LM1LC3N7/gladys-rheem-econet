# Rheem EcoNet

Vos chauffe-eau et thermostats Rheem et Ruud dans Gladys, par le cloud EcoNet
(l'application EcoNet, États-Unis et Canada). Nécessite **Gladys 5.2** ou
plus récent (l'énergie par jour).

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
| Consigne de l'eau                | En °F, du minimum de l'appareil jusqu'à la **consigne maximale de l'eau** de la configuration (120 °F par défaut, voir « Brûlures et légionelle »).                                                                                                 |
| Eau chaude disponible            | 0, 33, 66 ou 100 %, le niveau du ballon affiché par l'application (appareils qui le remontent).                                                                                                                                                     |
| Chauffe                          | 1 quand l'appareil chauffe.                                                                                                                                                                                                                         |
| Vanne d'arrêt                    | Un capteur d'ouverture, en lecture seule, quand une vanne est installée : 1 fermée, 0 ouverte. Gladys ne l'ouvre ni ne la ferme jamais.                                                                                                             |
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

Un appareil qui a à la fois High Demand et Performance ne propose que le
premier ; l'autre est quand même affiché comme Boost quand l'appareil y est.

**Thermostats** (chaque zone d'un système multizone est un appareil) :

| Fonctionnalité                         | Ce que c'est                                                                                                                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Température                            | La température de la pièce, en °F.                                                                                           |
| Humidité                               | En %, quand elle est remontée.                                                                                               |
| Consignes de chauffage / climatisation | En °F ; en mode auto elles gardent l'écart (zone neutre) que demande le thermostat.                                          |
| Mode                                   | Arrêt, chauffage, climatisation, auto. Le chauffage d'appoint est affiché comme chauffage, la ventilation seule comme arrêt. |
| Mode EcoNet                            | Tous les modes du thermostat, ventilation seule et chauffage d'appoint compris.                                              |
| Fonctionnement                         | Au repos, chauffe ou climatise.                                                                                              |
| Vitesse de ventilation                 | Auto, basse, moyenne-basse, moyenne, moyenne-haute, haute, max (selon le thermostat).                                        |
| Ventilation                            | Auto ou marche (continue), quand le thermostat a ce réglage.                                                                 |
| Alertes actives                        | Comme pour les chauffe-eau.                                                                                                  |

Dans une scène, testez **Mode EcoNet** (et non Mode) pour distinguer la
ventilation seule ou le chauffage d'appoint : Mode ne peut pas les montrer.

Toutes les températures sont en **°F**, l'unité qu'EcoNet remonte
(consignes en degrés entiers, comme l'application les règle). Si le compte
ou un appareil annonce une autre unité, l'intégration le signale dans son
statut et refuse les consignes tant que ce n'est pas vérifié : réglez
l'application EcoNet en Fahrenheit.

## Configuration

1. Dans l'onglet **Configuration**, saisissez l'**adresse e-mail** et le
   **mot de passe** de votre application EcoNet, puis enregistrez.
2. Vérifiez la **consigne maximale de l'eau** (voir plus bas).
3. Utilisez **Tester la connexion** : il se connecte et liste vos équipements.
4. Ouvrez l'onglet **Découverte** et ajoutez les appareils voulus.

La **langue des noms de fonctionnalités** s'applique aux appareils découverts
ensuite.

## Brûlures et légionelle

Au-delà de 120 °F (49 °C), l'eau chaude peut brûler en quelques secondes, un
enfant ou une personne âgée en premier. Gladys refuse toute consigne de l'eau
au-dessus de la **consigne maximale de l'eau** de la configuration, 120 °F
par défaut, quoi que demande une scène ou une commande vocale.

Une eau gardée tiède, sous 140 °F (60 °C), laisse la légionelle se
développer dans le ballon. Si vous voulez le ballon à 140 °F pour cette
raison, relevez le maximum à 140 °F en connaissance de cause, avec un
mitigeur sur l'eau chaude. Les limites de l'appareil s'appliquent toujours.
Le nouveau plafond s'applique aux commandes dès que la configuration est
enregistrée. Le curseur d'un appareil déjà créé, lui, ne change qu'après un
clic sur **Mettre à jour** pour cet appareil dans l'onglet **Découverte** ;
d'ici là, une consigne au-dessus du plafond reste refusée.

## Fonctionnement

- Au démarrage, l'intégration se connecte, lit la liste des équipements du
  compte et ouvre le lien en direct (MQTT sur TLS, celui de l'application
  EcoNet) : les changements arrivent en quelques secondes, et les commandes
  passent par lui.
- Tout le compte est relu toutes les 30 minutes (toutes les 5 minutes quand
  le lien en direct est coupé), et l'énergie des derniers jours toutes les
  6 heures.
- Une commande part une fois les vérifications passées (équipement en ligne,
  état récent, limites), une à la fois par équipement. L'intégration attend
  ensuite jusqu'à 30 secondes que l'équipement remonte la nouvelle valeur ;
  sinon, c'est noté dans les logs et Gladys réaffiche la dernière valeur
  remontée par l'équipement.
- Le badge d'un appareil indique **Cloud** ; avec un point orange quand le
  lien en direct est coupé (les états sont alors lus toutes les 5 minutes et
  les commandes indisponibles), **Injoignable** quand EcoNet signale
  l'appareil hors ligne ou ne répond pas.

## Limites

- Les commandes ont besoin du lien en direct : quand il est coupé, une
  commande est refusée avec un message. Elles sont aussi refusées quand
  EcoNet signale l'équipement hors ligne, ou quand son état date de plus de
  45 minutes. Une commande qui arrive pendant que la précédente du même
  équipement attend sa confirmation patiente 3,5 secondes au plus, puis est
  refusée : réessayez quelques secondes plus tard.
- Un mot de passe refusé n'est jamais retenté tout seul (pour ménager votre
  compte) : corrigez-le puis enregistrez, ou appuyez sur **Tester la
  connexion** quand il fonctionne à nouveau. Un jeton refusé quelques minutes
  après son émission espace les connexions suivantes (5, 10, 20 minutes…
  jusqu'à 6 heures) ; quand seul le lien en direct le refuse, celui-ci attend
  30 minutes (puis davantage) sans nouvelle connexion au compte.
- Quand EcoNet demande de ralentir (HTTP 429), plus rien n'est envoyé pendant
  la durée demandée, 15 minutes au moins.
- Pas encore pris en charge : l'absence et les vacances programmées, la
  reprise du programme, la consommation d'eau, le signal Wi-Fi, la consigne
  du déshumidificateur, le détail des alertes. Les appareils au gaz n'ont pas
  la fonctionnalité d'énergie (EcoNet la donne en kBTU).

## Confidentialité

Votre adresse e-mail et votre mot de passe ne sont envoyés qu'à EcoNet
(HTTPS), le jeton qu'EcoNet renvoie reste en mémoire et rien n'est écrit sur
le disque. Le mot de passe, le jeton et l'adresse e-mail n'apparaissent
jamais dans les logs.

## Dépannage

- « EcoNet a refusé l'e-mail ou le mot de passe » : vérifiez-les dans
  l'application EcoNet.
- « les mises à jour en direct sont coupées » : l'intégration réessaie (10 s,
  puis plus longtemps, 5 minutes au plus). Les états continuent d'arriver
  toutes les 5 minutes.
- « Risque de brûlure » : la consigne dépasse la consigne maximale de l'eau
  de la configuration.
- Une fonctionnalité manque : l'appareil est construit d'après ce que
  l'équipement remontait à sa découverte. Supprimez l'appareil et relancez
  une découverte après une mise à jour du micrologiciel.

Rheem, Ruud et EcoNet sont des marques de leurs propriétaires respectifs.
Cette intégration est non officielle et sans lien avec Rheem.
