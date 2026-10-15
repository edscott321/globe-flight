# Globe Flight

A browser game: you fly a Cessna 172 over a globe of the world. Fuel burns at the airplane's book rate, a steady wind pushes you off course, and you land at airports to fill the tanks. Below 3,000 feet, small "i" bubbles appear on the map; fly over one to open a short fact about that place.

The live version is at **https://ethandavidmagalei.com/fly/**. This repository is the same game as a plain static site, separate from the rest of that website.

This is a game. It is not a flight simulator for training, and none of its numbers should be used to plan a real flight.

## Run it locally

The page loads its data with `fetch`, so it has to be served over http (opening `index.html` from disk will not work).

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000/ in a browser. There is no build step and nothing to install. The only outside file is d3 7.9.0, loaded from cdnjs with a pinned version and a subresource-integrity hash.

To put it on GitHub Pages, push the repository and turn on Pages for the `main` branch, root folder. All paths are relative, so it also works from a subfolder on any static host.

## How to play

On the start card, pick an airport (Salt Lake City is the default; Heber Valley, Provo and Palo Alto are the others), then either **Start in the air** (level at 4,500 feet, 105 knots) or **Take off from the runway**. If you have flown before on this browser, **Pick up where I left off** puts you back where you were.

| Control | What it does |
| --- | --- |
| Left / Right arrows, or A / D | bank and turn |
| Down arrow or S | pull back to climb |
| Up arrow or W | push forward to descend, like a yoke (a setting swaps this) |
| E / Q, or the mouse wheel, or the throttle slider | throttle up and down |
| Hold the mouse button (or a finger) on the map | the plane turns and climbs toward that point |
| M | the plane follows the cursor without holding the button |
| P or Esc | pause |

**Taking off:** throttle up, wait for 55 knots, then pull back.

**Landing:** come down within 4 nautical miles of an airport at 85 knots or less, sinking no faster than 1,000 feet a minute. Once you stop, a **Fill the tanks** button appears. A slow landing away from an airport (70 knots or less, sinking under 700 feet a minute) is an off-field landing: you are down safe but there is no fuel. Anything harder counts as a crash and puts you back on the ground at the nearest airport with full tanks.

**The leg card** (bottom right) points you at the nearest i bubble you have not found, the nearest airport, or an airport you pick. It works out the true course, distance, wind correction angle, heading to fly, ground speed, time en route, fuel needed with the 30-minute reserve, and the VFR cruising altitude for that direction. These are the same sums a pilot does on an E6B flight computer.

The settings (up arrow climbs, the arrow toward your target, sound) and the list of bubbles you have found are saved in your browser's local storage. So is your position, every 4 seconds, for "pick up where I left off".

## The numbers it uses

All in `js/fly-lib.js`. The airplane figures are rounded from the Cessna 172S handbook.

| | |
| --- | --- |
| Usable fuel | 53 US gallons |
| Stall speed | 48 knots with flaps down, 53 clean (the stall horn sounds below 58) |
| Rotate speed | 55 knots |
| Best rate of climb speed | 74 knots |
| Cruise | about 120 knots true |
| Never-exceed speed | 163 knots |
| Service ceiling | 14,000 feet |
| Best climb at sea level | 730 feet a minute, shrinking to zero near the ceiling |
| Fuel burn | 1.5 gallons an hour at idle, plus 9.5 times the throttle (0 to 1): about 8.5 at 75% power, 11 at full |
| True airspeed | indicated airspeed plus 2% for every 1,000 feet of altitude |
| Fuel reserve | 30 minutes at the current burn (the daytime VFR rule, 14 CFR 91.151) |
| VFR cruising altitudes | above 3,000 feet: courses 0 to 179 degrees fly odd thousands plus 500 (3,500, 5,500 ...), 180 to 359 even thousands plus 500 (4,500, 6,500 ...), from 14 CFR 91.159 |

A full tank goes about 600 nautical miles with the reserve.

**Time is sped up.** The game clock runs 60 times faster than real time for every 1,000 feet of altitude, with a minimum of 6 times (on the ground) and a maximum of 900 times. At 4,500 feet that is 270 times: one real second is 4.5 game minutes. Fuel burns and the airplane moves on the game clock. Turns happen in real time, and climbs and descents run 12 times faster than real (less near the ground), so a climb does not take minutes.

**Simplifications:**

- The wind is made up, not real weather. It is steady: westerly in the middle latitudes, easterly trade winds within 25 degrees of the equator, and stronger the higher you fly. The same place and altitude always gets the same wind.
- The VFR altitude rule goes by magnetic course; the game uses the true course because it has no magnetic variation map.
- Altitudes are above the ground. The globe has no terrain heights, so you cannot hit a mountain.
- There are no flaps, no runways (an airport is a point), no traffic and no airspace.

## Files

```
index.html          the page
css/style.css       its styles
js/boot.js          loads data/*.json, then the three scripts below in order
js/globe.js         draws the globe with d3-geo on a canvas; js/fly.js moves its camera
js/fly-lib.js       the flight numbers (no page code, so Node can test it)
js/fly.js           the game: controls, the airplane, instruments, landing, fuel, the bubbles
data/airports.json  airports (70 picked by hand, then 791 from Natural Earth, marked "ne": true)
data/facts.json     the 96 i bubbles: a place, a title, one or two sentences, a Wikipedia link
globe-data/         the map (see below)
tests/              Node tests for js/fly-lib.js and the data files
```

Run the tests with Node 18 or later:

```sh
node --test tests/
```

## Where the map comes from

- **Natural Earth** (public domain, https://www.naturalearthdata.com/): land, lakes and rivers at 1:110m (`globe-data/world-110.json`) and 1:50m (`world-50.json`); the 1:10m land, coasts, lakes, rivers, roads and populated places in 10-degree tiles (`t10/`); mountain ranges and named peaks (`mountains.json`); and the airports marked `"ne": true` in `data/airports.json` (Natural Earth 1:10m airports).
- **OpenStreetMap** (© OpenStreetMap contributors, Open Database License 1.0, https://www.openstreetmap.org/copyright): streets, trails, water and parks for three small areas: Heber Valley in Utah, the Stanford and Bay Area, and Fallen Leaf Lake near Lake Tahoe (`globe-data/osm/`). The game shows this credit on screen whenever that data is drawn.
- The i bubble facts were written for ethandavidmagalei.com; place facts were checked against the Wikipedia article each one links to.

All map files are pre-packed JSON (integer coordinates, delta-encoded) made from the sources above.

## What is different from the version on the website

This copy has only the flying game. Removed: the website's header and navigation, the gate that asks you to earn game time first, the homepage globe's other modes (its pins and article panels, the Spokes bike-route ride-along, the Sierra Camp rides, the Moon and the trip to Europa, the filter and the places list, drag and zoom controls), and the cache-busting version numbers. Links inside a fact that pointed at other pages of the website now open that page on ethandavidmagalei.com in a new tab; links from one fact to another are plain text.

## License

The code is MIT licensed (see `LICENSE`). The map data keeps its own terms: Natural Earth is public domain, and the OpenStreetMap-derived files in `globe-data/osm/` are under the ODbL.
