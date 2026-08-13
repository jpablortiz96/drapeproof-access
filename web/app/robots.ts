import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*", allow: ["/", "/how-it-works", "/privacy"],
      disallow: ["/api/", "/try", "/session", "/result", "/passport", "/passports", "/_internal/"],
    },
  };
}
