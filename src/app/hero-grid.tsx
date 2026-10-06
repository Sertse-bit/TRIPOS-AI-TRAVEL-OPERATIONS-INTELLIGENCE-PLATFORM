"use client";

import { useEffect, useRef, type ReactNode } from "react";
import {
  createGridDistortion,
  easePointer,
  INACTIVE_POINTER,
  toClipSpace,
  type ClipPointer,
  type GridColor,
  type GridRenderer,
} from "@/components/grid-distortion";

/**
 * The hero's decorative grid-distortion backdrop (Phase 26).
 *
 * Three behaviours worth knowing:
 *
 * - **Never blank.** A CSS grid layer is always rendered underneath, so
 *   the hero looks intentional before hydration, when WebGL2 is missing,
 *   and if the shader fails to compile. The canvas only ever adds detail.
 * - **Reduced motion is a still frame, not nothing.** Users who asked for
 *   less motion get the grid at rest (strength 0.35, time 0) with no
 *   animation loop at all — the decoration stays, the movement doesn't.
 * - **The loop stops when nobody can see it** (tab hidden, or the loop
 *   was never started because of reduced motion), so an offscreen
 *   decoration cannot burn frames — see Phase 29's budget.
 *
 * The GL plumbing and the maths live in `components/grid-distortion.ts`
 * so they can be driven by a fake context in tests; this file is only
 * lifecycle, listeners, and the data attributes a test can assert on.
 */

/** How strong the effect is when frozen for `prefers-reduced-motion`. */
export const STATIC_FRAME_STRENGTH = 0.35;

const DEFAULT_LINE: GridColor = { hex: "#3a72ac", alpha: 0.5 };

export function HeroGrid({
  className = "",
  children,
}: {
  className?: string;
  children?: ReactNode;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;

    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    if (!gl) {
      // No WebGL2: the CSS layer is already the fallback, so there is
      // nothing to repair and nothing to fake.
      canvas.dataset.webgl = "unavailable";
      return;
    }

    /** Reads the theme's decorative line colour, with a literal fallback. */
    const readColor = (): GridColor => {
      const value = getComputedStyle(host).getPropertyValue("--grid-line").trim();
      return { hex: /^#[0-9a-fA-F]{6}$/.test(value) ? value : DEFAULT_LINE.hex, alpha: 0.5 };
    };

    let renderer: GridRenderer;
    try {
      renderer = createGridDistortion(gl, { color: readColor() });
    } catch (error) {
      // Surfaced, not swallowed: an effect that silently disappears is
      // worse than one that says why it is gone.
      canvas.dataset.webgl = "failed";
      console.error("Hero grid distortion disabled:", error);
      return;
    }
    canvas.dataset.webgl = "active";

    const dpr = window.devicePixelRatio || 1;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const darkScheme = window.matchMedia("(prefers-color-scheme: dark)");

    const target: ClipPointer = { ...INACTIVE_POINTER };
    let current: ClipPointer = { ...INACTIVE_POINTER };
    let frameId = 0;
    let lastFrameAt = 0;
    let startedAt = 0;

    const sizeCanvas = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      canvas.width = Math.max(1, Math.round(rect.width * Math.min(dpr, 2)));
      canvas.height = Math.max(1, Math.round(rect.height * Math.min(dpr, 2)));
      renderer.resize(rect.width, rect.height, dpr);
    };

    const renderStill = () => {
      renderer.render({ time: 0, pointer: INACTIVE_POINTER, strength: STATIC_FRAME_STRENGTH });
    };

    const tick = (now: number) => {
      const dt = lastFrameAt === 0 ? 1 / 60 : Math.min(0.05, (now - lastFrameAt) / 1000);
      lastFrameAt = now;
      current = easePointer(current, target, dt);
      renderer.render({ time: (now - startedAt) / 1000, pointer: current });
      frameId = window.requestAnimationFrame(tick);
    };

    const start = () => {
      if (frameId !== 0 || reduceMotion.matches) return;
      startedAt = performance.now();
      lastFrameAt = 0;
      frameId = window.requestAnimationFrame(tick);
    };

    const stop = () => {
      if (frameId === 0) return;
      window.cancelAnimationFrame(frameId);
      frameId = 0;
    };

    const onPointerMove = (event: PointerEvent) => {
      const next = toClipSpace(
        event.clientX,
        event.clientY,
        host.getBoundingClientRect() as DOMRect,
      );
      target.x = next.x;
      target.y = next.y;
    };

    const onPointerLeave = () => {
      target.x = INACTIVE_POINTER.x;
      target.y = INACTIVE_POINTER.y;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };

    const onResize = () => {
      sizeCanvas();
      if (reduceMotion.matches) renderStill();
    };

    const onMotionPreference = () => {
      if (reduceMotion.matches) {
        stop();
        renderStill();
      } else {
        start();
      }
    };

    const onSchemeChange = () => {
      renderer.setColor(readColor());
      if (reduceMotion.matches) renderStill();
    };

    sizeCanvas();
    if (reduceMotion.matches) renderStill();
    else start();

    host.addEventListener("pointermove", onPointerMove);
    host.addEventListener("pointerleave", onPointerLeave);
    host.addEventListener("pointercancel", onPointerLeave);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    reduceMotion.addEventListener("change", onMotionPreference);
    darkScheme.addEventListener("change", onSchemeChange);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => onResize());
    observer?.observe(host);

    return () => {
      stop();
      observer?.disconnect();
      host.removeEventListener("pointermove", onPointerMove);
      host.removeEventListener("pointerleave", onPointerLeave);
      host.removeEventListener("pointercancel", onPointerLeave);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
      reduceMotion.removeEventListener("change", onMotionPreference);
      darkScheme.removeEventListener("change", onSchemeChange);
      renderer.dispose();
    };
  }, []);

  return (
    <div ref={hostRef} className={`relative ${className}`}>
      {/*
       * The decorative layers are `aria-hidden` individually — NOT on the
       * root, which would hide the hero card nested inside it along with
       * the decoration. `pointer-events-none` keeps them out of the way;
       * the root still receives bubbled pointer moves from the card on
       * top, which is what drives the distortion.
       *
       * The CSS grid is the always-on fallback: visible before the canvas
       * paints, and the whole visual when WebGL2 is absent.
       */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-2xl"
      >
        <div
          className="absolute inset-0 opacity-60"
          style={{
            backgroundImage:
              "linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage: "radial-gradient(120% 90% at 50% 40%, black 35%, transparent 78%)",
            WebkitMaskImage: "radial-gradient(120% 90% at 50% 40%, black 35%, transparent 78%)",
          }}
        />
        <canvas ref={canvasRef} data-webgl="pending" className="absolute inset-0 h-full w-full" />
      </div>
      {children}
    </div>
  );
}
