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
}

export class RailCatalogEncodingError extends Error {
  constructor(encoding: unknown) {
    super(
      `catalog encoding ${JSON.stringify(encoding)} is not supported by this CLI — ` +
        `run npm install -g @itpay/cli to upgrade; the committed catalog is intact`,
    );
    this.name = "rail_catalog_encoding";
  }
}

type Row = unknown[];

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asIndex(v: unknown, bound: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v >= bound) {
    throw new Error("shared_rows: index out of bounds");
  }
  return v;
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

  if (encoding === undefined || encoding === null) {
    const rows = Array.isArray(catalog["journeys"]) ? (catalog["journeys"] as Row) : [];
    return {
      packed: false,
      journeys: rows.map((j) => {
        const rec = (j ?? {}) as Record<string, unknown>;
        const ref = asString(rec["ref"]) ?? asString(rec["journey_id"]) ?? "?";
        return {
          ref,
          route: asString(rec["route"]) ?? asString(rec["route_text"]) ?? asString(rec["summary"]) ?? "",
          defaultLayer: layerOf(ref),
          rides: Array.isArray(rec["rides"]) ? rec["rides"] as Record<string, unknown>[] : [],
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
  const stations = (catalog["stations"] ?? {}) as Record<string, unknown>;
  const services = (catalog["services"] ?? {}) as Record<string, unknown>;
  const seatNames = (catalog["seat_names"] ?? {}) as Record<string, unknown>;
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
        const ride = rideTable[asIndex(pair[0], rideTable.length)] as Row;
        const serviceRef = Array.isArray(ride[4]) ? ride[4][0] : undefined;
        const service = (services[asString(serviceRef) ?? ""] ?? {}) as Record<string, unknown>;
        const offers = Array.isArray(service.of) ? service.of as Row[] : [];
        return {
          train_code: service.tc,
          from_station: stations[asString(ride[2]) ?? ""] ?? ride[2],
          to_station: stations[asString(ride[3]) ?? ""] ?? ride[3],
          boarding_date: ride[0], departure: service.dep, arrival: service.arr,
          wait_minutes: pair[1],
          seats: offers.map((offer) => ({ seat_type: offer[1], seat_name: seatNames[asString(offer[1]) ?? ""] ?? offer[1],
            inventory_status: offer[2], quantity: offer[3], unit_price_fen: offer[4] })),
        };
      });
      return { ref, route, defaultLayer: layerOf(ref), rides };
    }),
  };
}
