# Testing DrapeProof

Production: [https://drapeproof-access.vercel.app](https://drapeproof-access.vercel.app)

No account is required. Sessions are anonymous, owner-isolated, and scheduled to expire after 24 hours.

## Recommended flow

1. Open the production URL and select **Try a look**.
2. Add a clear source photo containing one person.
3. Add a clean clothing or bag product image.
4. Draw one or more protected polygons around details you want inspected.
5. Review the images and protected areas before generation.
6. Generate once, then leave the processing page open while the provider task and verification stages progress.
7. Review scene continuity, protected-area results, and the original/AI comparison.
8. If Preserve Mode is offered, open the confirmation and choose whether to restore the eligible area from the original.
9. Open the DrapeProof Passport and, when finished, delete the session.

## Image input

- JPEG or PNG
- Maximum file size: 10 MB
- Minimum dimensions: 512 × 384
- Maximum long edge: 4096 px
- Use a clear single-person source image and an unobstructed product image

The YouCam provider may impose additional pose or content constraints. Seated photos and complex assistive-device scenes can fall outside a provider's preferred inputs.

## Protected regions

Protect the smallest meaningful area and label it plainly, such as “watch,” “joystick,” or “tattoo.” Avoid drawing directly over the clothing or bag you are intentionally changing. Multiple regions are supported.

DrapeProof first runs the Global Continuity Gate. Local region results appear only when the original and generated scenes remain comparable.

## Preserve Mode

Preserve Mode is optional and is offered only for eligible review/changed regions. It copies source-derived pixels, blends a bounded edge, preserves the AI provider output as a separate version, and re-verifies the result. It never asks the provider for another generation.

## Legitimate blocked result

“This preview changed too much” is an expected fail-safe when pose, framing, or stable scene structure no longer supports a defensible local comparison. In that state protected areas are not classified and restoration remains unavailable.

## Automated checks

```bash
npm test
npm run typecheck
npm run build
npm run audit:production
```

The provider-free production smoke is:

```bash
npm run smoke:production -- https://drapeproof-access.vercel.app
```

## Limitations

DrapeProof evaluates visual correspondence only. It does not establish physical fit, sizing, product safety, assistive-device function, accessibility compatibility, medical condition, or biometric identity.
