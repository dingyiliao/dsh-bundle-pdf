/**
 * Minimal structural declaration of the one DSH session lifecycle event this
 * plugin observes. Keeping it local avoids taking a build-time dependency on
 * the session package (and its large type graph) while remaining compatible
 * with the runtime's event dispatch.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'session/disposed'(this: unknown, session: { readonly id: string }): void
  }
}

export {}
