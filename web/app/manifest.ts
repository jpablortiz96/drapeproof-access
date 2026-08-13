import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "DrapeProof", short_name: "DrapeProof",
    description: "Careful AI virtual try-on with user-guided visual continuity checks.",
    start_url: "/", display: "standalone", background_color: "#090b0e", theme_color: "#090b0e",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }],
  };
}
