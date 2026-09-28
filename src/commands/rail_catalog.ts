import { CLI_VERSION, cliDistribution } from "../state/config.js";

// shared_rows.v1 catalog decode for the rail planning full-catalog read.
// The committed rail.catalog.v3 may ship positional rows (journeys, plans,
// profiles keyed by journey_columns plus shared ride_table / *_index tables)
// instead of per-journey objects. Decode a compact row for both JSON and
// human-readable output while the full evidence remains available by journey.

export interface RailCatalogJourneySummary {
  ref: string;
  route: string;
  defaultLayer: "main" | "backup";
  rides?: Record<string, unknown>[];
  calculation_scope?: Record<string, unknown>;
  ticket_plans?: Record<string, unknown>[];
  selected_plan?: Record<string, unknown>;
  detail?: { command: string; reason: string };
}

export class RailCatalogEncodingError extends Error {
  constructor(encoding: unknown) {
    super(
      `catalog encoding ${JSON.stringify(encoding)} is not supported by CLI ${CLI_VERSION} ` +
        `(${cliDistribution()}); obtain a compatible exact version through this installation channel. ` +
        `The committed catalog is intact`,
    );
    this.name = "rail_catalog_encoding";
  }
}

type Row = unknown[];

function scopeFromProfiles(value: unknown): Record<string, unknown> | undefined {
  const profiles = Array.isArray(value) ? value : [];
  const selected = profiles.find((p) => Array.isArray(p) && Array.isArray(p[1]) && p[1].includes("balanced")) ?? profiles[0];
  if (!Array.isArray(selected)) return { origin: "legacy_unknown", destination: "legacy_unknown",
    duration_basis: "legacy_unknown", arrival_basis: "legacy_unknown", cost_basis: "legacy_unknown",
    duration_minutes: null, estimated_total_cost: null, cost_incomplete: true };
  const extras = selected[10] && typeof selected[10] === "object" ? selected[10] as Record<string, unknown> : {};
  const total = typeof selected[9] === "number" && extras.ci !== true ? selected[9] / 100 : null;
  return {
    origin: extras.os ?? "legacy_unknown", destination: extras.ds ?? "legacy_unknown",
    duration_basis: extras.db ?? "legacy_unknown", arrival_basis: extras.ab ?? "legacy_unknown",
    cost_basis: extras.cb ?? "legacy_unknown", duration_minutes: selected[8] ?? null,
    estimated_total_cost: total, cost_incomplete: extras.ci === true,
  };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asIndex(v: unknown, bound: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= bound) {
    throw new Error("shared_rows: index out of bounds");
  }
  return v;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function datedTime(date: unknown, value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(raw)) return raw.replace("T", " ").slice(0, 16);
  const short = raw.match(/^(\d{2}:\d{2})(?:\+(\d+))?$/);
  const day = asString(date);
  if (!short || !day) return null;
  if (!short[2]) return `${day} ${short[1]}`;
  const shifted = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(shifted.getTime())) return null;
  shifted.setUTCDate(shifted.getUTCDate() + Number(short[2]));
  return `${shifted.toISOString().slice(0, 10)} ${short[1]}`;
}

function elapsedMinutes(departure: string | null, arrival: string | null): number | null {
  if (!departure || !arrival) return null;
  const start = Date.parse(departure.replace(" ", "T") + "Z");
  const end = Date.parse(arrival.replace(" ", "T") + "Z");
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 60_000 : null;
}

function seatOffer(row: unknown, names: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(row)) return null;
  const extras = asObject(row[7]);
  const code = asString(row[1]);
  return {
    offer_ref: row[0], seat_type: code ?? null, seat_name: code ? names[code] ?? code : null,
    inventory_status: row[2] ?? null, quantity: row[3] ?? null, unit_price_fen: row[4] ?? null,
    eligible: row[5] === true, requires_quote: row[6] === true,
    price_source: extras.s ?? "sale_price", quote_price_unverified: extras.u === true,
    conflicted: extras.c === true,
    ...(Array.isArray(extras.o) ? { price_observations_fen: extras.o } : {}),
  };
}

function decodeRide(row: unknown, wait: unknown, stations: Record<string, unknown>,
  services: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(row)) {
    const ride = asObject(row);
    if (!Object.keys(ride).length) throw new Error("rail catalog: malformed ride row");
    const refs = Array.isArray(ride.service_refs) ? ride.service_refs : [];
    const codes = [...new Set(refs.map((ref) => asObject(services[asString(ref) ?? ""]).tc)
      .filter((code): code is string => typeof code === "string" && code.length > 0))];
    const departure = datedTime(ride.boarding_date, ride.departure_at ?? ride.departure);
    const arrival = datedTime(ride.boarding_date, ride.arrival_at ?? ride.arrival);
    return { train_codes: codes, train_code: codes.join("/"),
      from_station: stations[asString(ride.from_station_code) ?? ""] ?? ride.from_station ?? null,
      to_station: stations[asString(ride.to_station_code) ?? ""] ?? ride.to_station ?? null,
      boarding_date: ride.boarding_date ?? null,
      departure, arrival, duration_minutes: elapsedMinutes(departure, arrival),
      wait_minutes: typeof wait === "number" ? wait : ride.wait_minutes ?? null,
      same_run: ride.same_run === true, onboard_stops: Array.isArray(ride.onboard_stops) ? ride.onboard_stops : [],
    };
  }
  const extras = asObject(row[8]);
  const refs = Array.isArray(row[4]) ? row[4] : [];
  const codes = [...new Set(refs.map((ref) => asObject(services[asString(ref) ?? ""]).tc)
    .filter((code): code is string => typeof code === "string" && code.length > 0))];
  const base = row[0];
  const departure = datedTime(base, extras.dep);
  const arrival = datedTime(base, extras.arr);
  return {
    train_codes: codes, train_code: codes.join("/"),
    from_station: stations[asString(row[2]) ?? ""] ?? row[2] ?? null,
    to_station: stations[asString(row[3]) ?? ""] ?? row[3] ?? null,
    boarding_date: base ?? null,
    departure, arrival, duration_minutes: elapsedMinutes(departure, arrival),
    wait_minutes: typeof wait === "number" ? wait : typeof row[5] === "number" ? row[5] : null,
    same_run: row[6] === true, onboard_stops: Array.isArray(row[7]) ? row[7] : [],
  };
}

function decodePlans(rawPlans: unknown, rawProfiles: unknown, packed: boolean,
  catalog: Record<string, unknown>, services: Record<string, unknown>,
  names: Record<string, unknown>, stations: Record<string, unknown>): {
    plans: Record<string, unknown>[]; selected?: Record<string, unknown> } {
  const plans = Array.isArray(rawPlans) ? rawPlans : [];
  const profiles = Array.isArray(rawProfiles) ? rawProfiles : [];
  const preferred = profiles.find((profile) => Array.isArray(profile) && Array.isArray(profile[1]) && profile[1].includes("balanced")) ?? profiles[0];
  const profile = Array.isArray(preferred) ? preferred : [];
  const serviceIndex = Array.isArray(catalog.service_index) ? catalog.service_index : [];
  const selectedPlan = packed && typeof profile[2] === "number" ? plans[asIndex(profile[2], plans.length)] :
    plans.find((plan) => Array.isArray(plan) && plan[0] === profile[2]);
  const selectedRef = Array.isArray(selectedPlan) ? selectedPlan[0] : null;
  const decoded = plans.map((plan) => {
    if (!Array.isArray(plan)) throw new Error("rail catalog: malformed ticket plan");
    const refs = (Array.isArray(plan[1]) ? plan[1] : []).map((ref) =>
      packed && typeof ref === "number" ? serviceIndex[asIndex(ref, serviceIndex.length)] : ref);
    const extras = asObject(plan[7]);
    const legs = refs.map((ref, index) => {
      const service = asObject(services[asString(ref) ?? ""]);
      const offers = Array.isArray(service.of) ? service.of : [];
      const selectedOffer = plan[0] === selectedRef && Array.isArray(profile[3]) ? profile[3][index] : undefined;
      const chosen = packed && typeof selectedOffer === "number" ? offers[asIndex(selectedOffer, offers.length)] :
        offers.find((offer) => Array.isArray(offer) && offer[0] === selectedOffer);
      return {
        service_ref: ref ?? null, train_code: service.tc ?? null,
        from_station: stations[asString(service.f) ?? ""] ?? service.f ?? null,
        to_station: stations[asString(service.t) ?? ""] ?? service.t ?? null,
        departure: datedTime(service.d, service.dep), arrival: datedTime(service.d, service.arr),
        seat_options: offers.map((offer) => seatOffer(offer, names)).filter((offer) => offer !== null),
        ...(chosen ? { selected_seat: seatOffer(chosen, names) } : {}),
      };
    });
    const amount = asObject(plan[3]);
    return {
      ticket_plan_ref: plan[0], passenger_count: plan[2] ?? null,
      purchase_support: plan[6] ?? "none", rail_amount_verified: plan[4] === true,
      rail_amount_fen: { default: amount.def ?? null, minimum: amount.min ?? null, maximum: amount.max ?? null },
      service_fee_fen: plan[5] ?? null, quote_price_unverified: extras.qu === true,
      legs,
    };
  });
  const selected = decoded.find((plan) => plan.ticket_plan_ref === selectedRef);
  return { plans: decoded, ...(selected ? { selected } : {}) };
}

// _cn_route_text port: "南头 C7608 → 广州南换乘71分 → G2944 重庆西" — kept
// byte-identical with the planner so a packed journey renders the same text
// its object form carried.
function regenerateRoute(
  ridePairs: Row[],
  rideTable: Row[],
  stations: Record<string, unknown>,
  services: Record<string, unknown>,
): string {
  const name = (code: unknown, fallback: unknown): string =>
    asString(stations[asString(code) ?? ""]) ?? asString(fallback) ?? asString(code) ?? "?";
  const rides = ridePairs.map((pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("shared_rows: malformed ride pair");
    const src = rideTable[asIndex(pair[0], rideTable.length)];
    if (!Array.isArray(src)) throw new Error("shared_rows: malformed ride row");
    return { row: src, wait: pair[1] };
  });
  const first = rides[0];
  if (first === undefined) return "";
  const trainCodes = (rideRow: Row): string[] =>
    (Array.isArray(rideRow[4]) ? (rideRow[4] as Row) : [])
      .map((ref) => {
        const svc = services[asString(ref) ?? ""];
        return asString((svc as Record<string, unknown> | undefined)?.tc);
      })
      .filter((c): c is string => Boolean(c));
  const waitOf = (ride: { row: Row; wait: unknown }): number | undefined =>
    typeof ride.wait === "number" ? ride.wait
      : typeof ride.row[5] === "number" ? (ride.row[5] as number)
      : undefined;
  const sameRun = (rideRow: Row): boolean => rideRow[6] === true;
  const parts = [`${name(first.row[2], undefined)} ${trainCodes(first.row).join("/")}`];
  for (let i = 1; i < rides.length; i += 1) {
    const prev = rides[i - 1]!.row;
    const ride = rides[i]!;
    const via = name(prev[3], undefined);
    const wait = waitOf(ride);
    parts.push(
      sameRun(ride.row)
        ? wait !== undefined ? `${via}同车停${wait}分` : `${via}同车接续`
        : wait !== undefined ? `${via}换乘${wait}分` : `${via}换乘`,
    );
    parts.push(`${trainCodes(ride.row).join("/")} ${name(ride.row[3], undefined)}`);
  }
  if (rides.length === 1) {
    parts.push(name(first.row[3], undefined));
  }
  return parts.filter((s) => s.trim().length > 0).join(" → ");
}

// decodeRailCatalogJourneys returns one summary per committed combination in
// catalog order. Legacy object-form catalogs (no `encoding`) pass through;
// shared_rows.v1 rows are positional under journey_columns
// [ref, route, rides, plans, gc, pr, profiles, tc, ev, rep, tw, risk].
// Any other encoding throws RailCatalogEncodingError — an explicit upgrade
// hint, never an empty catalog.
export function decodeRailCatalogJourneys(
  catalog: Record<string, unknown>,
): { journeys: RailCatalogJourneySummary[]; packed: boolean } {
  const encoding = catalog["encoding"];
  const layerMap =
    ((catalog["choice_layers"] as Record<string, unknown> | undefined)?.["journey_layer"] as
      Record<string, unknown> | undefined) ?? {};
  const layerOf = (ref: string): "main" | "backup" =>
    layerMap[ref] === "backup" ? "backup" : "main";
  const stations = asObject(catalog.stations);
  const services = asObject(catalog.services);
  const seatNames = asObject(catalog.seat_names);

  if (encoding === undefined || encoding === null) {
    const rows = Array.isArray(catalog["journeys"]) ? (catalog["journeys"] as Row) : [];
    return {
      packed: false,
      journeys: rows.map((j) => {
        const rec = (j ?? {}) as Record<string, unknown>;
        const ref = asString(rec["ref"]) ?? asString(rec["journey_id"]) ?? "?";
        const calculationScope = scopeFromProfiles(rec["profiles"]);
        const rides = (Array.isArray(rec.rides) ? rec.rides : []).map((ride) => decodeRide(ride, null, stations, services));
        const ticketPlans = decodePlans(rec.plans, rec.profiles, false, catalog, services, seatNames, stations);
        return {
          ref,
          route: asString(rec["route"]) ?? asString(rec["route_text"]) ?? asString(rec["summary"]) ?? "",
          defaultLayer: layerOf(ref),
          rides,
          ...(calculationScope ? { calculation_scope: calculationScope } : {}),
          ticket_plans: ticketPlans.plans,
          ...(ticketPlans.selected ? { selected_plan: ticketPlans.selected } : {}),
        };
      }),
    };
  }
  if (encoding !== "shared_rows.v1") {
    throw new RailCatalogEncodingError(encoding);
  }
  const columns = catalog["journey_columns"];
  if (!Array.isArray(columns) || columns[0] !== "ref" || columns[1] !== "route" || columns[2] !== "rides") {
    throw new RailCatalogEncodingError(`${String(encoding)} (unexpected journey_columns)`);
  }
  const rideTable = (Array.isArray(catalog["ride_table"]) ? catalog["ride_table"] : []) as Row[];
  const journeys = (Array.isArray(catalog["journeys"]) ? catalog["journeys"] : []) as Row[];
  return {
    packed: true,
    journeys: journeys.map((row) => {
      if (!Array.isArray(row)) throw new Error("shared_rows: journey row is not an array");
      const ref = asString(row[0]) ?? "?";
      const route =
        asString(row[1]) ??
        (Array.isArray(row[2]) ? regenerateRoute(row[2] as Row[], rideTable, stations, services) : "");
      const rides = (Array.isArray(row[2]) ? row[2] as Row[] : []).map((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error("shared_rows: malformed ride pair");
        return decodeRide(rideTable[asIndex(pair[0], rideTable.length)], pair[1], stations, services);
      });
      const calculationScope = scopeFromProfiles(row[6]);
      const ticketPlans = decodePlans(row[3], row[6], true, catalog, services, seatNames, stations);
      return { ref, route, defaultLayer: layerOf(ref), rides,
        ...(calculationScope ? { calculation_scope: calculationScope } : {}),
        ticket_plans: ticketPlans.plans,
        ...(ticketPlans.selected ? { selected_plan: ticketPlans.selected } : {}) };
    }),
  };
}
