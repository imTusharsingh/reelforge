import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { ReferenceLibraryService } from "./reference-library.service.js";
import { REFERENCE_LIBRARY } from "./planning.ports.js";
@Module({
  imports: [IdentityModule],
  providers: [
    ReferenceLibraryService,
    { provide: REFERENCE_LIBRARY, useExisting: ReferenceLibraryService },
  ],
  exports: [REFERENCE_LIBRARY],
})
export class ReferenceLibraryModule {}
