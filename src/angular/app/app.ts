//#region Imports

import { Component, ElementRef, OnInit, ViewChild } from "@angular/core";
import { NavigationEnd, Router, RouterOutlet } from "@angular/router";
import { IdentityService } from "./core/services/identity.service";
import { HeaderComponent } from "./shared/header/header.component";
import { WizzComponent } from "./shared/wizz/wizz.component";
import { FooterComponent } from "./shared/footer/footer.component";
import { CommonModule } from "@angular/common";

//#endregion

interface Versions {
  current: string;
  last: string;
}

@Component({
  selector: "app-root",
  imports: [
    RouterOutlet,
    HeaderComponent,
    WizzComponent,
    FooterComponent,
    CommonModule,
  ],
  templateUrl: "./app.html",
})
export class App implements OnInit {
  //#region Attributes

  /** Conteneur principal de la page. */
  @ViewChild("main")
  private readonly main: ElementRef<HTMLElement> | undefined;

  protected versions: Versions | undefined;

  //#endregion
  constructor(
    private readonly identityService: IdentityService,
    private readonly router: Router
  ) {}

  //#region Functions

  ngOnInit(): void {
    // On scroll vers le haut à chaque fois que l'utilisateur change de page.
    this.router.events.subscribe((event) => {
      if (this.main) {
        if (event instanceof NavigationEnd) {
          this.main.nativeElement.scrollTo(0, 0);
        }
      }
    });

    // Getting the project version.
    //@ts-ignore
    window.electronAPI.getVersion().then((versions: any) => {
      this.versions = versions;

      /*
      if (versions.current != versions.last && versions.last) {
        const ALERT = document.createElement("a");
 
        ALERT.classList.add("alert");
        FOOTER.append(ALERT);
      }
        */
    });
  }

  protected onNewUpdateLinkClick(): void {
    //@ts-ignore
    window.electronAPI.openURL(
      "https://github.com/HeyHeyChicken/EBP-Replay-Cutter/releases/latest"
    );
  }

  //#endregion
}
