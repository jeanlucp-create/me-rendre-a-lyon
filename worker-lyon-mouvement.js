// Cloudflare Worker — Lyon en mouvement
// Agrège : P+R TCL + LPA/Indigo/Q-Park + Vélo'v + Citiz + Leo&Go
//
// v3m : Fusion LPA — si le flux multi-opérateurs renvoie
//       places_disponibles=null pour un parking LPA, on va chercher
//       la valeur dans le flux LPA-only (parking_temps_reel.json,
//       source directe des matériels de péage LPA) via id_gestionnaire.
//       Filet de sécurité en cas de panne ponctuelle du champ LPA
//       dans le flux v2, sans dépendre uniquement de cette source.

export default {
  async fetch(request) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Content-Type': 'application/json',
    };

    const EMAIL = 'jean.luc.perrotto@gmail.com';
    const PASSWORD = 'VOTRE_MOT_DE_PASSE';
    const glHeaders = { 'Authorization': 'Basic ' + btoa(`${EMAIL}:${PASSWORD}`) };

    // GPS des P+R TCL (non inclus dans l'API v2)
    const GPS_TCL = {
      'SOI':  { lat: 45.7600685, lng: 4.9219167 },
      'BON':  { lat: 45.7650778, lng: 4.9097108 },
      'CUI':  { lat: 45.7860531, lng: 4.8313213 },
      'DECC': { lat: 45.7709080, lng: 4.9539465 },
      'DECG': { lat: 45.7746803, lng: 4.9765677 },
      'GOR':  { lat: 45.7667619, lng: 4.8032697 },
      'GREY': { lat: 45.7477438, lng: 4.6972905 },
      'HFVE': { lat: 45.6886393, lng: 4.8640701 },
      'HLS':  { lat: 45.7018287, lng: 4.8044086 },
      'IRYV': { lat: 45.6893217, lng: 4.8310262 },
      'MERP': { lat: 45.7304861, lng: 4.8897761 },
      'MEYG': { lat: 45.7717370, lng: 4.9971659 },
      'MEYP': { lat: 45.7661093, lng: 5.0357651 },
      'MEYZ': { lat: 45.7684301, lng: 5.0333604 },
      'OULN': { lat: 45.7175471, lng: 4.8148837 },
      'PAR':  { lat: 45.7201496, lng: 4.8857467 },
      'PORL': { lat: 45.8235555, lng: 4.7629362 },
      'ALP':  { lat: 45.7181865, lng: 4.9270161 },
      'BELA': { lat: 45.6926743, lng: 4.9567400 },
      'VAI1': { lat: 45.7818860, lng: 4.8059600 },
      'VAI2': { lat: 45.7818860, lng: 4.8059600 },
      'VEN':  { lat: 45.7055849, lng: 4.8887287 },
    };

    try {
      // ── Récupération en parallèle de toutes les sources ──
      const [
        resParking,
        resParkingLPA,
        resVelovInfo,
        resVelovStatus,
        resCitizInfo,
        resCitizStatus,
        resLeoInfo,
        resLeoTypes,
      ] = await Promise.all([
        // Parkings (P+R TCL + LPA + Indigo + Q-Park)
        fetch('https://data.grandlyon.com/geoserver/metropole-de-lyon/ows?SERVICE=WFS&VERSION=2.0.0&request=GetFeature&typename=metropole-de-lyon:parkings-de-la-metropole-de-lyon-disponibilites-temps-reel-v2&outputFormat=application/json&SRSNAME=EPSG:4326', { headers: glHeaders }),
        // Parkings LPA seul — flux de secours (matériels de péage LPA en direct)
        fetch('https://download.data.grandlyon.com/files/rdata/lpa_mobilite.donnees/parking_temps_reel.json'),
        // Vélo'v — stations
        fetch('https://download.data.grandlyon.com/files/rdata/jcd_jcdecaux.jcdvelov/station_information.json'),
        // Vélo'v — statut temps réel
        fetch('https://download.data.grandlyon.com/files/rdata/jcd_jcdecaux.jcdvelov/station_status.json'),
        // Citiz — stations
        fetch('https://data.grandlyon.com/files/rdata/lpa_mobilite.donnees/station_information.json'),
        // Citiz — statut temps réel
        fetch('https://data.grandlyon.com/files/rdata/lpa_mobilite.donnees/station_status.json'),
        // Leo&Go — véhicules
        fetch('https://download.data.grandlyon.com/files/rdata/lag_leoandgo.disponibilite/free_bike_status.json'),
        // Leo&Go — types de véhicules
        fetch('https://download.data.grandlyon.com/files/rdata/lag_leoandgo.disponibilite/vehicle_types.json'),
      ]);

      const [
        dataParking,
        dataParkingLPA,
        dataVelovInfo,
        dataVelovStatus,
        dataCitizInfo,
        dataCitizStatus,
        dataLeo,
        dataLeoTypes,
      ] = await Promise.all([
        resParking.json(),
        resParkingLPA.ok ? resParkingLPA.json().catch(() => []) : Promise.resolve([]),
        resVelovInfo.json(),
        resVelovStatus.json(),
        resCitizInfo.json(),
        resCitizStatus.json(),
        resLeoInfo.json(),
        resLeoTypes.json(),
      ]);

      // ── FUSION LPA : map id_gestionnaire → dispo du flux LPA-only ──
      const lpaDispoMap = {};
      (Array.isArray(dataParkingLPA) ? dataParkingLPA : []).forEach(item => {
        const id = item['Parking_schema:identifier'];
        if (!id) return;
        lpaDispoMap[id] = {
          dispo: item.ferme ? 0 : item['mv:currentValue'],
          date: item['dct:date'],
        };
      });

      // ── PARKINGS ──
      const allParkings = (dataParking.features || []).map(f => {
        const p = f.properties;
        const coords = f.geometry?.coordinates;
        let lat = coords ? coords[1] : null;
        let lng = coords ? coords[0] : null;
        if (p.gestionnaire === 'TCL' && GPS_TCL[p.id_gestionnaire]) {
          lat = GPS_TCL[p.id_gestionnaire].lat;
          lng = GPS_TCL[p.id_gestionnaire].lng;
        }

        // Filet de sécurité : si le flux principal ne donne pas de dispo pour
        // un parking LPA, on va chercher dans le flux LPA-only (fallback).
        let placesDispo = p.places_disponibles;
        if (p.gestionnaire === 'LPA' && (placesDispo === null || placesDispo === undefined)) {
          const fallback = lpaDispoMap[p.id_gestionnaire];
          if (fallback && typeof fallback.dispo === 'number') {
            placesDispo = fallback.dispo;
          }
        }

        return {
          id: p.id,
          nom: p.nom,
          gestionnaire: p.gestionnaire,
          id_gestionnaire: p.id_gestionnaire,
          adresse: p.adresse,
          url: p.url,
          places_disponibles: placesDispo,
          etat: p.etat,
          nb_places: p.nb_places,
          nb_pmr: p.nb_pmr,
          nb_velo: p.nb_velo,
          nb_2_rm: p.nb_2_rm,
          hauteur_max: p.hauteur_max,
          tarif_1h: p.tarif_1h,
          tarif_2h: p.tarif_2h,
          tarif_3h: p.tarif_3h,
          tarif_4h: p.tarif_4h,
          tarif_24h: p.tarif_24h,
          horaires: p.gestionnaire === 'TCL' ? p.info : null,
          lat, lng,
          last_update: p.last_update,
        };
      });

      const tcl = allParkings
        .filter(p => p.gestionnaire === 'TCL')
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

      const operateurs = allParkings
        .filter(p => p.gestionnaire !== 'TCL')
        .sort((a, b) => {
          if (a.gestionnaire !== b.gestionnaire) return a.gestionnaire.localeCompare(b.gestionnaire, 'fr');
          return a.nom.localeCompare(b.nom, 'fr');
        });

      // ── VÉLO'V ──
      const velovStatusMap = {};
      (dataVelovStatus.data?.stations || []).forEach(s => {
        velovStatusMap[s.station_id] = s;
      });

      const velov = (dataVelovInfo.data?.stations || [])
        .filter(s => s.capacity > 0)
        .map(s => {
          const status = velovStatusMap[s.station_id] || {};
          const meca = status.vehicle_types_available?.find(v => v.vehicle_type_id === 'mechanical')?.count || 0;
          const elec = status.vehicle_types_available?.find(v => v.vehicle_type_id === 'electrical')?.count || 0;
          return {
            id: s.station_id,
            nom: s.name,
            adresse: s.address,
            lat: s.lat,
            lng: s.lon,
            capacite: s.capacity,
            velos_dispo: status.num_bikes_available || 0,
            velos_meca: meca,
            velos_elec: elec,
            places_libres: status.num_docks_available || 0,
            en_service: status.is_renting && status.is_installed,
            last_reported: status.last_reported,
          };
        })
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

      // ── CITIZ ──
      const citizStatusMap = {};
      (dataCitizStatus.data?.stations || []).forEach(s => {
        citizStatusMap[s.station_id] = s;
      });

      const citiz = (dataCitizInfo.data?.stations || [])
        .map(s => {
          const status = citizStatusMap[s.station_id] || {};
          const nomRaw = Array.isArray(s.name) ? s.name.find(n => n.language === 'fr')?.text || s.name[0]?.text : s.name;
          return {
            id: s.station_id,
            nom: nomRaw,
            adresse: s.address,
            lat: s.lat,
            lng: s.lon,
            capacite: s.capacity,
            vehicules_dispo: status.num_vehicles_available || 0,
            en_service: status.is_renting && status.is_installed,
            last_reported: status.last_reported,
          };
        })
        .filter(s => s.en_service)
        .sort((a, b) => a.nom.localeCompare(b.nom, 'fr'));

      // ── LEO&GO ──
      const leoTypesMap = {};
      (dataLeoTypes.data?.vehicle_types || []).forEach(t => {
        leoTypesMap[t.vehicle_type_id] = t;
      });

      const leoandgo = (dataLeo.data?.bikes || dataLeo.data?.vehicles || [])
        .filter(v => !v.is_reserved && !v.is_disabled)
        .map(v => {
          const type = leoTypesMap[v.vehicle_type_id] || {};
          return {
            id: v.bike_id,
            nom: type.name || 'Véhicule',
            lat: v.lat,
            lng: v.lon,
            electrique: type.propulsion_type === 'electric',
            autonomie_km: Math.round((v.current_range_meters || 0) / 1000),
            type: type.form_factor || 'car',
            last_reported: v.last_reported,
          };
        });

      return new Response(JSON.stringify({
        parkings: { tcl, operateurs },
        velov,
        autopartage: { citiz, leoandgo },
        meta: {
          nb_tcl: tcl.length,
          nb_operateurs: operateurs.length,
          nb_velov: velov.length,
          nb_citiz: citiz.length,
          nb_leoandgo: leoandgo.length,
          nb_lpa_fallback_used: Object.keys(lpaDispoMap).length,
          generated_at: new Date().toISOString(),
        }
      }), { headers: corsHeaders });

    } catch(e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: corsHeaders
      });
    }
  }
};
