import {railAftercareOrder,railAftercareList,railAftercareEnvelope,railAftercareCreate,railAftercareRespond} from "./aftercare.js";
import type { ServiceAdapter } from "../adapter.js";
import { railInputTemplate, railServiceGuidance, RAIL_ENDPOINT_BRIEF, locationInputInstruction, railOverviewInstruction } from "./guide.js";
import { railShouldWait, railPollAfter } from "./wait.js";
import { railInvocationProjection } from "./invocation.js";
import { railInputRecoveryInstruction, railRunError, railActionError } from "./recovery.js";
import { railWorkflowEnvelope } from "./review.js";
import { railPlanningEnvelope } from "./results.js";
import { railBookingEnvelope } from "./fulfillment.js";
import { railSavedResultEnvelope, railSavedDeliveryGuidance } from "./saved.js";
import { railCheckoutItinerary } from "./checkout.js";
import { renderRailResultPage } from "./page.js";
import { readSavedResult } from "./reading.js";
export const railAdapter: ServiceAdapter = {
 aftercare:{order:railAftercareOrder,directory:railAftercareList,present:railAftercareEnvelope,create:railAftercareCreate,respond:railAftercareRespond},
 entryInstruction: RAIL_ENDPOINT_BRIEF + "按 result.guidance 逐项填写输入（when_to_use 说明本服务适用场景、input_fields 是必填契约、input_example 是待填示意，必须替换用户真实值），然后继续同一服务执行。不要臆造字段名。",
 supported:true, inputTemplate:railInputTemplate, inputInstruction:railInputRecoveryInstruction,
 guidance:railServiceGuidance, requiresGuidance: id => id === "itpay-rail-smart",
 overviewInstruction:railOverviewInstruction, locationInstruction:locationInputInstruction,
 invocation:railInvocationProjection, shouldWait:railShouldWait, pollAfter:railPollAfter,
 preservesTerminalRecovery: model => model.workflow?.human_action?.context?.quote_recovery === true,
 projectState: model => model.rail_booking ? railBookingEnvelope(model) : model.rail_planning ? railPlanningEnvelope(model) : null,
 workflow:railWorkflowEnvelope, savedResult:railSavedResultEnvelope, deliveryGuidance:railSavedDeliveryGuidance,
 extraFacts: model => model.rail_booking ? {rail_booking:model.rail_booking} : {},
 runError:railRunError, actionError:railActionError, readResult:readSavedResult,
 renderPage: (...args) => {renderRailResultPage(...args);return true;},
 checkout:async(backend,model,id,token)=>railCheckoutItinerary(model,await backend.getCheckoutPresentation(id,token)),
};
