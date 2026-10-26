declare module '*.vue' {
  /*
   * Fallback for SFCs the language service cannot resolve, e.g. a dependency
   * that ships `src/**\/*.vue` sources but no component `.d.ts` (its barrel
   * `import X from './components/X.vue'` dangles). Props are open on purpose;
   * slots must stay open too, otherwise every named slot is rejected with
   * "Property 'left' does not exist on type '{}'".
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const component: any
  export default component
}

declare module '@mlightcad/cad-agent-plugin/style.css' {
  const css: string
  export default css
}

declare module '@mlightcad/cad-script-plugin/style.css' {
  const css: string
  export default css
}
