// Module augmentation for compromise/two: the bundled type definition
// for `two` (nlp entrypoint) does not declare the `acronyms` / `people`
// methods that the `three` entrypoint does, even though the runtime
// plugin works the same way. We augment the resolved `Two` interface
// with the methods we use so we can drop the `as unknown as ...`
// type assertion in glossaryExtractor.ts.

import type Two from 'compromise/types/view/two';

declare module 'compromise/types/view/two' {
  interface Two {
    acronyms: (n?: number) => Two;
    people: (n?: number) => Two;
  }
}
