"""
Het app-icoon van de kassa tekenen.

Waarom een script en geen los bestand: een icoon is nodig in acht formaten en
op vier plekken (Windows-installer, Android-launcher, het adaptieve icoon van
Android dat uit twee lagen bestaat, en het opstartscherm). Met de hand
bijhouden gaat gegarandeerd mis zodra er iets aan het ontwerp verandert.

    python scripts/logo-maken.py

Het ontwerp, en waarom:

  * Een gele kassabon op donkerblauw. Het geel en het blauw komen uit het
    logo van Truckwash1, zodat de kassa en de wasstraat-app naast elkaar van
    hetzelfde bedrijf zijn. De bon met de gescheurde onderrand zegt zonder
    woorden waar de app voor is.

  * Weinig onderdelen. Dit icoon staat straks 32 pixels breed in de
    Windows-taakbalk, en daar overleeft alleen een silhouet. Drie regels en
    een dikke totaalbalk is wat er bij die grootte van overblijft, en dat is
    genoeg om het van het dashboard te onderscheiden.

  * Getekend op vier keer de grootte en daarna verkleind. Dat is de
    goedkoopste manier om nette randen te krijgen zonder de vormen zelf glad
    te hoeven maken.
"""

from pathlib import Path
from PIL import Image, ImageDraw

WORTEL = Path(__file__).resolve().parent.parent

# Merkkleuren, letterlijk dezelfde als in kassa.css en theme.css
GEEL = (248, 192, 16, 255)
GEEL_DIEP = (217, 155, 10, 255)
DONKER = (20, 32, 47, 255)      # tekst op geel
BLAUW_BOVEN = (22, 35, 60, 255)
BLAUW_ONDER = (7, 12, 22, 255)

SCHAAL = 4  # tekenen op 4x en daarna verkleinen


def verloop(breedte, hoogte, boven, onder):
    """Een verticaal verloop. PIL kan dat niet zelf, dus regel voor regel."""
    laag = Image.new('RGBA', (breedte, hoogte))
    tekenaar = ImageDraw.Draw(laag)
    for y in range(hoogte):
        f = y / max(1, hoogte - 1)
        kleur = tuple(
            round(boven[i] + (onder[i] - boven[i]) * f) for i in range(4)
        )
        tekenaar.line([(0, y), (breedte, y)], fill=kleur)
    return laag


def gloed(breedte, hoogte):
    """
    De zachte gele gloed rechtsboven.

    Dezelfde gloed die in de app zelf rechtsboven in het werkvlak staat. Het
    is nauwelijks zichtbaar en juist daarom belangrijk: zonder valt het icoon
    dood op een donkere achtergrond.
    """
    laag = Image.new('RGBA', (breedte, hoogte), (0, 0, 0, 0))
    tekenaar = ImageDraw.Draw(laag)
    straal = int(breedte * 0.85)
    mid = (int(breedte * 0.95), int(hoogte * 0.05))
    stappen = 60
    for i in range(stappen, 0, -1):
        r = int(straal * i / stappen)
        alpha = int(30 * (1 - i / stappen) ** 1.6)
        tekenaar.ellipse(
            [mid[0] - r, mid[1] - r, mid[0] + r, mid[1] + r],
            fill=(248, 192, 16, alpha),
        )
    return laag


def bon(breedte, hoogte, met_gloed=True):
    """
    De bon zelf, op een doorzichtige laag.

    `breedte`/`hoogte` is het vlak waarin hij gecentreerd wordt. De bon vult
    ongeveer de helft: dat is wat er binnen de veilige zone van een adaptief
    Android-icoon past zonder afgesneden te worden.
    """
    laag = Image.new('RGBA', (breedte, hoogte), (0, 0, 0, 0))
    tekenaar = ImageDraw.Draw(laag)

    bw = int(breedte * 0.44)          # breedte van de bon
    bh = int(hoogte * 0.60)           # hoogte, inclusief de scheurrand
    x0 = (breedte - bw) // 2
    y0 = (hoogte - bh) // 2
    hoek = int(bw * 0.10)

    scheur_h = int(bh * 0.075)        # hoe hoog de zaagtand is
    romp_h = bh - scheur_h

    # De romp: boven afgerond, onder recht (daar komt de scheurrand).
    tekenaar.rounded_rectangle(
        [x0, y0, x0 + bw, y0 + romp_h], radius=hoek, fill=GEEL,
    )
    tekenaar.rectangle([x0, y0 + romp_h - hoek, x0 + bw, y0 + romp_h], fill=GEEL)

    # De gescheurde onderrand: zeven tanden. Een oneven aantal, zodat er in
    # het midden een punt staat in plaats van een dal -- dat leest rustiger.
    tanden = 7
    stap = bw / tanden
    punten = [(x0, y0 + romp_h)]
    for i in range(tanden):
        punten.append((x0 + stap * (i + 0.5), y0 + romp_h + scheur_h))
        punten.append((x0 + stap * (i + 1), y0 + romp_h))
    tekenaar.polygon(punten, fill=GEEL)

    # De regels op de bon. Onderaan de dikke totaalbalk; die is wat je bij
    # 32 pixels nog ziet.
    marge = int(bw * 0.18)
    lijn_x0 = x0 + marge
    lijn_x1 = x0 + bw - marge
    dik = max(1, int(bh * 0.045))

    regels = [
        (0.26, 1.00),   # (hoogte in de bon, breedte als deel van de regel)
        (0.40, 0.72),
        (0.54, 0.88),
    ]
    for f, deel in regels:
        y = y0 + int(romp_h * f)
        tekenaar.rounded_rectangle(
            [lijn_x0, y, lijn_x0 + (lijn_x1 - lijn_x0) * deel, y + dik],
            radius=dik // 2, fill=DONKER,
        )

    # De totaalbalk: dikker, en met een streep erboven zoals op een echte bon.
    y = y0 + int(romp_h * 0.70)
    tekenaar.rounded_rectangle(
        [lijn_x0, y, lijn_x1, y + max(1, dik // 2)], radius=1, fill=GEEL_DIEP,
    )
    y += int(dik * 1.6)
    tekenaar.rounded_rectangle(
        [lijn_x0, y, lijn_x1, y + dik * 2], radius=dik, fill=DONKER,
    )

    return laag


def icoon(maat, afgerond=True, achtergrond=True, bon_erop=True):
    """Het hele icoon op de gevraagde maat."""
    groot = maat * SCHAAL
    doek = Image.new('RGBA', (groot, groot), (0, 0, 0, 0))

    if achtergrond:
        vlak = verloop(groot, groot, BLAUW_BOVEN, BLAUW_ONDER)
        vlak = Image.alpha_composite(vlak, gloed(groot, groot))

        if afgerond:
            # Windows zet geen masker om een icoon, dus ronden we zelf af.
            masker = Image.new('L', (groot, groot), 0)
            ImageDraw.Draw(masker).rounded_rectangle(
                [0, 0, groot - 1, groot - 1], radius=int(groot * 0.19), fill=255,
            )
            doek.paste(vlak, (0, 0), masker)
        else:
            doek.paste(vlak, (0, 0))

    if bon_erop:
        doek = Image.alpha_composite(doek, bon(groot, groot))

    return doek.resize((maat, maat), Image.LANCZOS)


def opstartscherm(breedte, hoogte, donker=True):
    """Het scherm dat je een seconde ziet terwijl de app laadt."""
    if donker:
        vlak = verloop(breedte, hoogte, BLAUW_BOVEN, BLAUW_ONDER)
        vlak = Image.alpha_composite(vlak, gloed(breedte, hoogte))
    else:
        vlak = verloop(breedte, hoogte, (246, 248, 251, 255), (238, 241, 246, 255))

    # Het merk in het midden, klein gehouden: een opstartscherm is geen poster.
    zij = int(min(breedte, hoogte) * 0.30)
    merk = icoon(zij, afgerond=False, achtergrond=False)
    vlak = vlak.convert('RGBA')
    vlak.alpha_composite(merk, ((breedte - zij) // 2, (hoogte - zij) // 2))
    return vlak


def bewaar(afbeelding, *pad):
    doel = WORTEL.joinpath(*pad)
    doel.parent.mkdir(parents=True, exist_ok=True)
    afbeelding.save(doel)
    kb = doel.stat().st_size / 1024
    print(f'  {"/".join(pad):44s} {afbeelding.size[0]}x{afbeelding.size[1]}  {kb:7.1f} kB')


def main():
    print('\nHet icoon van de kassa\n')

    # Windows: electron-builder maakt hier zelf de .ico uit.
    bewaar(icoon(1024), 'build', 'icon.png')

    # Voor de app zelf (inlogscherm, balk).
    bewaar(icoon(512), 'src', 'assets', 'kassa-icoon.png')

    # Android en iOS, via @capacitor/assets.
    bewaar(icoon(1024), 'assets', 'icon.png')
    # Het adaptieve icoon van Android bestaat uit twee losse lagen: de
    # launcher schuift en maskeert ze zelf, dus mag de voorgrond geen
    # achtergrond hebben en moet hij ruim binnen de rand blijven.
    bewaar(icoon(1024, afgerond=False, achtergrond=False), 'assets', 'icon-foreground.png')
    bewaar(icoon(1024, afgerond=False, bon_erop=False), 'assets', 'icon-background.png')

    bewaar(opstartscherm(2732, 2732, donker=True), 'assets', 'splash.png')
    bewaar(opstartscherm(2732, 2732, donker=True), 'assets', 'splash-dark.png')

    print('\nKlaar. Voor Android/iOS daarna: npm run assets:icons\n')


if __name__ == '__main__':
    main()
