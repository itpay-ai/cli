import type { ServiceExecutionReadModel, CheckoutPresentation } from "../../client/types.js";
export function railCheckoutItinerary(booking: ServiceExecutionReadModel | undefined,presentation:CheckoutPresentation): {itinerary?:Record<string,unknown>;itineraryTitle?:string} {
      const review = booking?.workflow?.human_action?.context?.review as Record<string, unknown> | undefined;
      const quote = presentation.rail_quote;
      const facts = quote?.legs ?? booking?.rail_booking?.legs ?? (Array.isArray(review?.legs) ? review.legs : []);
      const legs = facts.filter(value=>value && typeof value==="object").map(value=>{
        const leg=value as Record<string,unknown>;
        return {travel_date:leg.travel_date,train_code:leg.train_code,
          from_station:leg.from || leg.from_station || `站点代码 ${String(leg.from_station_code ?? "未知")}（名称暂缺）`,
          to_station:leg.to || leg.to_station || `站点代码 ${String(leg.to_station_code ?? "未知")}（名称暂缺）`,
          departure:leg.departure ?? leg.departure_time,arrival:leg.arrival ?? leg.arrival_time,
          arrival_days:leg.arrival_days,seat_name:leg.seat_name || leg.seat_type_name || `席别代码 ${String(leg.seat_type ?? "未知")}（名称暂缺）`};
      });
      if(legs.length){
        const itinerary={legs,passengers:quote?.passengers ?? review?.passengers ?? null,purchase_unit:"journey"};
        const itineraryTitle=legs.map(leg=>[leg.train_code,leg.from_station,"->",leg.to_station].filter(value=>typeof value==="string" && value.length).join(" ")).join(" / ");
        return {itinerary,itineraryTitle};
      }
 return {};
}
