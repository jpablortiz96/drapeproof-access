"use client";
import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";
import { SpeedInsights } from "@vercel/speed-insights/next";
import { normalizeAnalyticsUrl } from "../../lib/analytics-url";

export function PublicTelemetry() {
  const isQa = () => typeof document !== "undefined" && document.cookie.split(";").some((value) => value.trim() === "dp_qa=1");
  return <><Analytics beforeSend={(event: BeforeSendEvent) => isQa() ? null : ({ ...event, url: normalizeAnalyticsUrl(event.url) })}/><SpeedInsights beforeSend={(event) => isQa() ? null : ({ ...event, url: normalizeAnalyticsUrl(event.url) })}/></>;
}
