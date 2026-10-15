# Product-market fit research

Last updated: 2026-10-15. Evidence for the "Business viability (20%): clear customer and a real problem" criterion in `docs/DELIVERABLES.md`, for judges and the team.

How to read it. Every sourced number comes from a claim that passed a fact-check against its source; project figures were read from the repo. Where the check found a claim only partly right, the corrected value is used. Claims the check did not cover are left out, even when they point the same way. Design targets and plans are ours and say so. Kind labels: **measured** (stated by the source), **derived** (our arithmetic on sourced numbers, working shown), **estimate** (our judgement), **assumption** (an untested input). Sources are numbered in section 10.

## 1. PMF thesis

Independent, owner-run cafés, takeaways, bars and late-trading shops set their opening hours and lighting by habit, so they cut hours to save energy without knowing which hours earn: food and drink firms were 8 times as likely as the average firm to cut trading hours in 2022 (20.6% against 2.5% [9]), while in Hackney 36% of high-street card spend happens between 6pm and 6am [21]. The pressure is current: the smallest business electricity users paid 38.36p/kWh in Q2 2026, 2.16 times Q2 2021 [1]; 91% of accommodation and food firms were concerned about energy prices in late September 2026, the highest share of any industry [7]; and Shoreditch's night-time spend fell 10% in 2025 [22]. Smart City Sim simulates the whole area overnight and gives each owner 1-3 priced changes to hours and lighting every week; because one simulation serves every shop in the area, the LLM cost is about £0.41 per store per month (projected from a measured run [75]), low enough for a BID or council to buy it for a whole street.

## 2. Ideal customer profile and early adopters

User: the owner-operator. Buyer: the owner (direct), or a sponsor that buys seats for its members (a BID or a council high-street programme).

| Criterion | Ideal customer | Evidence |
| --- | --- | --- |
| Business | Independent, owner-operated, 1-3 sites on a high street: café, restaurant, takeaway, bar or pub, off-licence or convenience store | 78.1% of UK food and drink sites are run by micro or small firms, and micro firms average 1.002 sites each (Mar 2024) [34]. 71% of the 50,925 convenience stores in mainland UK are run by independents; 89% of those run one store [35] |
| Who decides | The owner sets the hours and pays the electricity bill | Design requirement |
| Trading pattern | Open after 6pm on at least some days | Hackney has the highest night share of any London borough: 36% of in-store high-street card spend is 6pm-6am (London 25%) [21]. Shoreditch night spend fell 10% in 2025 [22] |
| Energy exposure | Electricity is a large, visible cost | 91% of accommodation and food firms concerned about energy prices in late Sep 2026 [7], 88% in late June [8]. 73% of Hotel and Catering firms struggled to keep up with energy bills (Jul 2023) [10] |
| Measurable | Smart or advanced electricity meter, and a till or card terminal that exports sales by hour | 67% of meters at smaller non-domestic sites covered by the rollout are smart or advanced (Jun 2026) [4]. Hourly till export: assumption, checked at onboarding |
| Reachable | Member of a BID or a council high-street programme | 11 London BIDs and 21 councils already subscribe to pooled area data at £10k (BID) or £20k (borough) a year, list price [45]. 48% of BIDs work on ESG for themselves or their members [36] |

Segment order: hospitality first (cafés, bars, restaurants, takeaways), shops and off-licences second. In BEIS energy-tool pilots, small retailers were less open to paying than hospitality businesses; the report suggests they see their use as too low to save much, and notes its retail interviewees were smaller [20]. The levers differ by type. Lighting is 20.6% of a small shop's electricity but about 5% of a café's, where cooking takes 79% (UK 2025, modelled) [3]. For hospitality the main lever is hours and equipment run time; for shops it is lighting.

Early adopters (the first 20-40 shops) pass four tests:

| Test | Why | Evidence |
| --- | --- | --- |
| Changed, or debated changing, hours or days in the last 12 months | A live decision, with a before and after to measure | 20.6% of food and drink firms cut hours in the 3 months to Oct 2022 [9]; 42% of hospitality venues were cutting daily hours in Jan 2023 [12]; 29% expected to cut hours in Jan 2025 [13]; 48% of independent F&B operators had reduced opening days (May 2026) [14] |
| A recent bill shock or contract renewal | The pain is fresh | A café owner: bills 4x in three years (2023) [15]; a south London café-bar quoted £4,000 against £1,000 (2022) [16]; an East End pie-and-mash shop paying more than double on a contract signed before the war in Ukraine (2022) [17] |
| Late trade with uncertain weeknights | Money on both sides of the hours question | Brick Lane restaurateurs: late-night trade about a third of income (2014) [18]; Hackney businesses cite "inconsistent customer numbers" (2024 consultation, 78 businesses) [22] |
| Reachable through a sponsor | Sponsor introductions keep acquisition cost low (6.5) | Hackney Council's night-time strategy already tracks Shoreditch with HSDS footfall and spend data [22] |

Excluded in v1 (hypotheses to test): chain and franchise sites (hours set centrally), sites whose energy is included in the rent, and sites with neither meter data nor a till export.

## 3. The problem, with evidence

### 3.1 Electricity is expensive, most of all for the smallest users

| Evidence | Value | Kind | Source |
| --- | --- | --- | --- |
| Electricity price, smallest business users (0-20 MWh a year), incl. Climate Change Levy, excl. VAT | 38.36p/kWh in Q2 2026 (provisional) against 17.74p in Q2 2021: 2.16x | Measured; ratio derived | [1] |
| Same band, 2025 average, against small users (20-499 MWh) | 34.93p against 29.09p/kWh | Measured | [1] |
| Median electricity use per building, England and Wales, 2024 | Hospitality 10,000 kWh; shops 7,900 kWh | Measured | [2] |
| Median yearly bill at the 2025 price | Hospitality £3,493 (£67 a week); shop £2,759 (£53 a week). At Q2 2026 prices: £3,836 and £3,030 | Derived: kWh x price | [1, 2] |
| Firms with some concern about energy prices, late Sep 2026 | 72% of all firms, the highest since the question began in Mar 2026; accommodation and food 91%, the highest industry | Measured (survey) | [7] |
| Hotel and Catering firms struggling to keep up with energy bills, Jul 2023 | 73% | Measured (survey, n=1,000 overall) | [10] |
| Small firms planning to close, downsize or change model if energy support were cut, Nov 2022 | 24% overall; 42% accommodation and food; 34% wholesale and retail | Stated intent (n=1,054) | [11] |
| Owners in their own words | "Our energy bills are 4x what they were when we opened 3 years ago" (café, 2023) [15]. A board-game café-bar quoted £4,000 against £1,000: "We're open late at night when it's cold, we have lots of lights, we have freezers, ovens" (2022) [16] | Anecdote | [15, 16] |

### 3.2 Hours get cut to save energy, without demand data

| Evidence | Value | Kind | Source |
| --- | --- | --- | --- |
| Food and drink firms that cut trading hours (same days) in the 3 months to Oct 2022 to reduce energy costs | 20.6% against 2.5% of all firms (8.2x) | Measured; ratio derived | [9] |
| Hospitality venues cutting hours, Jan 2023 (members expected Q1 bills up 101% year on year) | 42% fewer hours a day; 34% fewer days a week | Survey | [12] |
| Operators of 8,300 hospitality sites expecting to cut trading hours after the April 2025 cost rises | 29% | Survey (expectation) | [13] |
| Independent F&B operators that had reduced opening days (Zempler Bank; sample and period not given) | 48% | Survey | [14] |
| In-store town-centre card spend between 6pm and 6am, Oct-Dec 2023 | London 25%; Hackney 36%, the highest borough (1.44x London) | Measured; ratio derived | [21] |
| Hackney Saturday visitor footfall, 9pm-midnight against noon-3pm, 2023 | +4% | Measured | [21] |
| Brick Lane restaurateurs facing a midnight curfew, 2014 | Late-night trade "around a third of their total income" | Owner statement | [18] |
| Later opening on event nights, GLA Night Time Enterprise Zones (Bromley, Vauxhall, Woolwich, 2022-23) | Local spend 6-9pm up to +70% against the same dates in 2022 (best case); potential to more than double footfall after 6pm; 65 businesses extended their hours on event nights | Measured (evaluation) | [23] |
| Hackney evening and night-time consultation, 2024 (78 businesses) | Businesses face "inconsistent customer numbers", licensing restrictions and safety concerns | Qualitative | [22] |
| Firms that changed energy behaviour, Ofgem 2023 | "Many found the impact of the behaviour changes to be limited or difficult to measure." | Qualitative | [10] |

Our reading: cutting hours is a common hospitality response to energy costs (21-48% of operators in the surveys above), but in Hackney the hours after 6pm carry over a third of card spend. Owners see bills and till totals after the fact; nothing tells them in advance what a change of hours would save or lose.

### 3.3 Lights left on when nobody is buying

| Evidence | Value | Kind | Source |
| --- | --- | --- | --- |
| Lighting share of electricity, UK 2025 | Small shops 20.6%; pubs 11.1%; cafés about 5%; restaurants and takeaways 4.2%. Cooking is 79-81% in cafés and restaurants; cold storage 35.5% in small shops | Modelled estimate | [3] |
| Median shop's lighting spend | £2,759 x 20.6% = about £568 a year (£10.93 a week) | Derived | [1, 2, 3] |
| 1 kW of window or sign lighting left on 1am-7am every night | 6 h x 7 nights = 42 kWh a week x 38.36p = £16.11 a week (£838 a year) | Derived (unit conversion, not a measured load) | [1] |
| France: shop-window lighting off by 1am (or 1 hour after closing), not on before 7am (or 1 hour before opening) | In force since 1 July 2013; carried into the 2018 order that applies today | Law | [26, 27] |
| Forecast saving of the 2013 French rule (all non-residential lighting) | ADEME: 2 TWh a year; the ministry put it at about EUR 200m and 250,000 t CO2 a year | Forecast | [28] |
| France, Oct 2022 | Illuminated adverts off 1am-6am (with exceptions); breaking the switch-off rules for illuminated adverts and signs became a fifth-class offence | Law | [29] |
| City of London Lighting SPD, Oct 2023 | Curfews of 22:00, 23:00 or midnight by zone, for new development; owners of existing buildings are only asked to sign a voluntary charter | Planning guidance | [30] |
| DESNZ-funded digital tool, 90 hospitality businesses, 12-month trial | Bills cut by an estimated average of nearly £2,500 a year; overnight use down by up to 66% for some. Trial sites were larger than the median: £2,500 is 72% of a median hospitality bill (derived) | Measured (trial) | [5] |

### 3.4 High-street pressure

| Evidence | Value | Kind | Source |
| --- | --- | --- | --- |
| Shoreditch, 2025 against 2024 (Mastercard spend index and BT footfall, via the GLA High Streets Data Service) | Night spend -10%, Saturday spend -11%, night footfall -6%: the steepest night-spend fall of Hackney's town centres (borough: -2% night spend, -1% night footfall) | Measured | [22] |
| UK retail footfall, Sep 2026 against Sep 2025 (BRC-Sensormatic, one tracker) | -2.9% overall; high streets -3.0% | Measured | [24] |
| High-street vacancy | Central London 7%; median London suburban high street 8-10%; Newport 19% | Measured | [25] |

Our reading: London high streets are not emptying. The pressure shows in trading per unit, such as Shoreditch's 2025 night-time fall.

## 4. Market size

Target classes: licensed and unlicensed restaurants and cafés, takeaways, pubs and bars (SIC 56101, 56102, 56103, 56302), and physical retail (SIC 47 minus fuel stations, market stalls and non-store sellers). "Independent" means a firm with under 50 staff; that covers 98.6% of target firms and includes franchisees, so it is a loose proxy [33].

### 4.1 Where the customers are

| Area | Food and drink sites | Physical retail sites | Target sites | Independents | Kind | Source |
| --- | --- | --- | --- | --- | --- | --- |
| UK | 163,010 | 245,875 | 408,885 | 296,190 firms | Derived from register counts | [31, 33] |
| London | 28,425 | 41,505 | 69,930 | 53,300 firms | Derived | [31, 33] |
| Hackney, Tower Hamlets, Islington, City of London | 4,340 | 4,885 | 9,225 | about 7,030 | Derived; independents estimated | [31] |
| Shoreditch + 5 fringe areas | 820 | 1,080 | about 1,900 (upper bound) | about 1,450 | Derived; independents estimated | [32] |
| Shoreditch only (MSOA E02007111) | 255 | 240 | 495 | about 380 | Derived; independents estimated | [32] |

Working:

- D1. UK food and drink = 38,735 + 37,565 + 49,360 + 37,350 = 163,010 sites. UK physical retail = 302,340 - 3,795 (fuel) - 3,250 (stalls) - 49,420 (non-store) = 245,875 [31]. Register snapshot 13 March 2026. Online sellers coded to store classes stay in, so retail is an upper bound on storefronts.
- D2. London: 9,560 + 7,780 + 7,460 + 3,625 = 28,425; 54,910 - 255 - 915 - 12,235 = 41,505 [31].
- D3. Boroughs (food and drink + retail): Hackney 1,125 + 1,525; Tower Hamlets 1,255 + 1,430; Islington 1,215 + 1,340; City 745 + 590 [31].
- D4. Shoreditch: 100 + 40 + 50 + 65 = 255 food and drink; 405 - 0 - 5 - 160 = 240 retail. Fringe areas: Hoxton South and East, Hoxton North and West, Brick Lane North, Spitalfields, Old Street and St Luke's [32]. Upper bound: non-store sellers are 40-59% of retail sites in three of these areas against 22% for London [31, 32], a sign of registered offices rather than shops, so the store-class counts are probably inflated too.
- D5. Independents = micro + small firms. UK: 136,205 food and drink + 159,985 retail = 296,190. London: 22,635 + 30,665 = 53,300 [33]. These count firms, not sites.
- D6. Local independents (estimate) = target sites x 76.2%, the London ratio of independent firms to target sites (53,300 / 69,930). No checked source gives a local independent share for retail. Shoreditch skews to bigger venues (55% of its target food and drink sites are micro, against 68% nationally [31, 32]), so about 1,450 is generous.

### 4.2 Store seats

Price: base £8 per store per month (£96 a year, section 6.1). Upside: £25 a month (£300 a year), an assumption that holds only if the pilot proves the extra-customers value.

| Market | Base | Stores | At £96 a year | At £300 a year | Kind |
| --- | --- | --- | --- | --- | --- |
| TAM | UK independents | 296,190 | £28.4m | £88.9m | Derived |
| SAM | London independents (the model needs TfL station flows) | 53,300 | £5.1m | £16.0m | Derived |
| SOM, year 1 | Shoreditch + fringe: 10% of about 1,450 pay | about 145 | £13.9k | £43.5k | Derived; 10% is an assumption |
| SOM, year 3 | Four boroughs: 10% of about 7,030 pay | about 703 | £67.5k | £210.9k | Derived; 10% is an assumption |

The 10% paying share is untested, and year 1 is likely optimistic (D4, D6).

### 4.3 BIDs: seat budgets (a channel, not extra revenue)

A BID that buys seats pays for store subscriptions, so this line overlaps 4.2 and is not added to it. The anchor is the £10,000 a year a London BID pays for pooled area data [45], about 104 seats at £96.

| Market | Base | BIDs | At £10k per BID a year | Seat equivalent | Source |
| --- | --- | --- | --- | --- | --- |
| TAM | UK BIDs (345 in the British Isles minus 5 in Ireland, Sep 2025) | 340 | £3.4m | about 35,400 | [36] |
| SAM | Greater London BIDs | 78 | £0.78m | about 8,100 | [36] |
| SOM | 1-3 London BIDs whose members include small shops | 1-3 | £10-30k | 104-312 | Assumption |

By March 2026 there were 352 BIDs, 81 of them in London [37]. £10k is a pooled, GLA-subsidised list price, with discounts for smaller BIDs [45].

### 4.4 Councils (phase 2): anonymised area data

| Market | Base | Councils | At £15k (hypothesis, 6.3) | At £20k (HSDS list price) | Source |
| --- | --- | --- | --- | --- | --- |
| TAM | UK councils: England 317, Scotland 32, Wales 22, Northern Ireland 11 | 382 | £5.73m | £7.64m | [48, 49] |
| SAM | London councils (32 boroughs + City) | 33 | £0.50m | £0.66m | [48] |
| SOM | Hackney, Tower Hamlets, Islington, City | 1-4 | £15-60k | £20-80k | Assumption |

The 382 counts county and district councils that cover the same areas. 21 of the 33 London councils already subscribe to pooled area data (HSDS), which competes for the same budget [45].

### 4.5 Combined

| Scenario | TAM (UK) | SAM (London) | SOM (year 3) |
| --- | --- | --- | --- |
| Base: seats at £96 + councils at £15k | £34.2m | £5.6m | £82.5k-£127.5k |
| Upside: seats at £300 + councils at £20k | £96.5m | £16.7m | £230.9k-£290.9k |

Context, the spend pool (derived, upper bound): UK small shops, cafés, pubs, restaurants and takeaways used 994.6 + 56.7 + 231.6 + 360.6 = 1,643.5 ktoe = 19,114 GWh of electricity in 2025, of which lighting was 248.2 ktoe = 2,887 GWh [3]. At small-user prices of 29.09-34.93p [1] that is £5.6-6.7bn a year, £0.84-1.01bn of it lighting. Larger sites in these segments pay less per kWh, so this overstates the bill.

## 5. Alternatives today, and how we differ

| Alternative | What the buyer gets | Price | Buyer | Gap |
| --- | --- | --- | --- | --- |
| Footfall counters: MRI OnLocation | 24-hour counts at fixed points, reports | £3,600 per outdoor counter a year; £860 indoors; excl. VAT [55] | Councils' high streets | Past counts at points; no per-store advice; no energy |
| Mobile-network data: BT Active Intelligence (EE devices) | Footfall trends, daily peaks, catchment | £15,000 to £300,000+ per order, 12-month or one-off [56] | Public bodies (G-Cloud) | Area level; expensive |
| Card-spend analytics: Beauclair | Sales insights from anonymised card data, optional BT location data | From £1,050 a month + set-up [57] | BIDs, councils | Area level; past spend |
| Pooled London data: GLA High Streets Data Service | BT footfall, Mastercard spend, Local Data Company premises, vacancy and opening hours; no energy | £10k per BID, £20k per borough, list [45] | 21 councils, 11 BIDs [45] | Area level; BIDs pass it on as reports, newsletters and events [43] |
| Council footfall contracts | Data plus evaluation | Sefton (Huq): £28,000 for 2 years, 4 towns [51]; Durham (Place Informatics): £76,336 for 4 years, 11 towns [52] | Councils | Area level |
| Supplier dashboards: British Gas Energy360 | Half-hourly use, out-of-hours reports | Free to its smart-meter business customers [58] | Owner | Shows what used energy, not which hours earn |
| Free public energy support | DESNZ-funded tool, free to 525+ hospitality SMEs in England [5]; GLA Business Climate Challenge: £6,000 of free support per business through BIDs and climate alliances, median cut almost 9% [47] | Free | Owner, through programmes | Energy only; not tied to footfall or hours |
| Tills and AI assistants: Square | Free and Plus plans (£0 or £69 a month per location), live sales on Plus [59]; Square AI, free in the UK since Feb 2026, combines a seller's own data with weather, events and neighbourhood trends for staffing, stock and promotions (Square's description) [60] | £0-£69 a month | Owner | Forecasts from the shop's own history; no area simulation; no energy or lighting advice in what we reviewed |
| Rota software: Deputy | Demand forecasting and auto-scheduling in the Core plan | $6.50 per user a month, annual billing [61] | Owner | Staff rotas, not opening hours or energy |

How we differ (our assessment of the products above; not a full market scan):

| Dimension | Today's tools | Smart City Sim |
| --- | --- | --- |
| Question answered | What happened: counts, spend indices, half-hourly kWh | What would happen if this shop changed its hours or lights, with a confidence level and cited evidence |
| Scope | Footfall, or energy, or sales | Hours, lighting, energy cost and expected customers in one recommendation |
| Unit | An area (council, BID) or one shop's own history | Per-store advice from one shared simulation of the area |
| Decision loop | Dashboards; quarterly area reports [44] | 1-3 changes a week, Approve or Reject, measured afterwards |
| Price per unit | £3,600 per counter a year; £10k-£20k+ a year per data buyer | £8 per store a month, at an LLM cost of £0.31-£0.48 per store a month (6.4) |

What incumbents could copy:

- Square is the largest risk. Square AI is free, already uses local context for staffing decisions, and Square holds the sales data and the sellers [60].
- Rota tools already sell demand forecasting (Deputy Core) [61]; energy suppliers already give away half-hourly data [58].
- Area-data vendors and HSDS hold the BID and council relationships [45, 55, 56].
- Our inputs (OpenStreetMap, TfL, grid carbon) are public, so data is not a moat.

What is harder to copy: (1) one simulation per area shared by every shop, so an extra shop costs about USD 0.064 a week in LLM spend at 1,000 shops per area (6.4); (2) the data firewall, which lets a sponsor buy for members without exposing any competitor's data; (3) each shop's approve, reject and measured-outcome history, which calibrates the next week and the next area.

## 6. Business model and unit economics

### 6.1 Price hypothesis: £8 per store per month, ex VAT (£96 a year)

The price has to pay back from energy savings alone, because the extra-customers figure is simulated and not yet calibrated (section 9). Savings rates come from the Carbon Trust's 2004-06 field trial of advanced metering at 538 SME sites: 12.3% identified and 5.1% implemented on average; sites given data only implemented 3%; sites sent profiles and recommendations by email, prepared by staff, implemented 7.5% [6]. Applied to the median bills in 3.1 (derived):

| Saving rate | Hospitality saves a month | Net of £8 | Shop saves a month | Net of £8 |
| --- | --- | --- | --- | --- |
| 3% (data only, implemented) | £8.73 | +£0.73 | £6.90 | -£1.10 |
| 5% (trial average, implemented) | £14.55 | +£6.55 | £11.50 | +£3.50 |
| 7.5% (emailed advice, implemented) | £21.83 | +£13.83 | £17.25 | +£9.25 |
| 12% (trial average, identified) | £34.93 | +£26.93 | £27.59 | +£19.59 |

Payback: at 5%, a month's £8 is covered by 2.4 weeks of savings (hospitality) and 3.0 weeks (shop); at the 12% identified rate, by 1.0 and 1.3 weeks.

Break-even implemented saving (derived: monthly price x 12 / median bill):

| Price a month | Hospitality | Shop | Reading |
| --- | --- | --- | --- |
| £8 | 2.75% | 3.48% | About the data-only rate (3%) |
| £15 | 5.15% | 6.52% | Above the trial average (5.1%) |
| £25 | 8.59% | 10.87% | Above the best tier (7.5%): needs the extra-customers value |

That is why £8 is the base price and £25 is the upside, conditional on the pilot proving extra customers.

Caveats: trial sites used about 30 times a median shop's electricity and most were multi-site, though the trial found no difference in percentage savings by company size; the rates are carbon savings across utilities [6]. DESNZ prices are fully delivered averages "including all elements except VAT" [1], so fixed charges are spread over each kWh; a saved kWh avoids only the unit rate, so these savings are an upper bound (our reading).

Comparators: £8 is 44% of Xero's entry plan (£18) [62], 11.6% of Square for Restaurants Plus (£69) [59] and 10.1% of Lightspeed Restaurant Basic (£79) [63]. The Carbon Trust's 2007 report estimated a fully automated advice service at £70 a year [6].

### 6.2 BID seats

Same price, invoiced to the BID once a year: £96 per seat.

| Seats | Cost to the BID a year | Share of median BID levy (£292,485) [36] | Note |
| --- | --- | --- | --- |
| 25 | £2,400 | 0.82% | 1.7% of a lower-quartile BID (£143k, 2022) [38] |
| about 104 | £10,000 | 3.4% | The HSDS fee for a BID [45] |
| about 103 | £9,939 | 3.4% | Team London Bridge spends £15k on bought-in data and £55k on net zero from a £2.06m levy (3.4%) [42]; applied to the median BID, that buys seats for 28% of its 369 premises [36] |
| 369 | £35,424 | 12.1% | Every premises in a median BID: too much, so seat retail and hospitality members only |

BIDs already buy area data and pass it to members: South Bank BID shares HSDS data through reports, newsletters and events [43], and started quarterly reports after levy payers asked for more regular updates [44].

### 6.3 Councils (phase 2)

Hypothesis (estimate): £15,000 per council per area a year for anonymised area data: energy use and its timing, footfall by hour, and shop and street lighting hours, each figure aggregated from at least 5 shops (design threshold). Anchors:

- Bexley pays £18,750 ex VAT for 15 months of HSDS membership, £15,000 a year [50]; the HSDS list price is £20,000 [45].
- Sefton paid £28,000 for two years (2023-25) of footfall data on 4 towns, £14,000 a year [51]; Durham pays £76,336 for 2024-28 on 11 towns, £19,084 a year (derived) [52]. Awarded council footfall contracts range from about £1,300 to £39,000 a year [53].
- HSDS covers footfall, spend, vacancy and premises but not energy [45]. That is the gap a council product fills.
- £15k equals about 156 seats at £96. HSDS prices are pooled and GLA-subsidised, so this is an analogy, not a comparable [45].

### 6.4 Cost to serve and gross margin

Measured: one live iteration with reports for 24 shops cost USD 0.3564 across 50 calls: Opus 5.5 analyst (2 calls) USD 0.0737, Sonnet 5.5 store agents (24 batched calls) USD 0.1379, Sonnet report wording (24 calls) USD 0.1448. With two connectivity checks the ledger total is USD 0.3571 [75]. That is USD 0.0149 per shop per iteration. Costs are computed from token counts with a price table that matches Anthropic's published rates, not taken from billed amounts; GBP uses a fixed 0.75 per USD [65, 75].

| Weekly session, 24 shops | USD a week | USD per store-week | £ per store-week | £ per store-month | Kind |
| --- | --- | --- | --- | --- | --- |
| Low: 10 iterations, reports worded once | 2.26 | 0.094 | 0.071 | 0.31 | Derived |
| Team projection | 3.00 | 0.125 | 0.094 | 0.41 | Projection |
| High: everything run 10 times | 3.56 | 0.149 | 0.111 | 0.48 | Derived |

Scale (derived): USD per store-week = 0.0635 + 0.7368 / stores in the area, if the analyst's cost does not grow with the area. That gives USD 0.071 at 100 stores and USD 0.064 at 1,000. Without the 50% batch discount on the store agents [65], an iteration would cost about USD 0.494.

Gross margin at £8 (LLM held at the high £0.48; hosting is one Vercel Pro plan at $20 a month [66]; Stripe UK fees [67]):

| Stores | Owner pays by card monthly | BID pays an annual Bacs invoice |
| --- | --- | --- |
| 24 (one area) | 81.4% | 85.3% |
| 100 | 87.4% | 91.3% |
| 1,000 | 89.1% | 93.0% |

Working: card fees 1.5% + 20p + 0.7% billing = £0.38 a month; Bacs 1% capped at £4 per invoice + 0.7% billing = £0.06-£0.07 per seat a month; hosting £15 a month spread over the stores. Stripe charges on the VAT-inclusive amount, which lowers card margins by about 0.4 points. Excluded: support, sales, and the servers that run the simulation and API.

### 6.5 Acquisition: why the channel matters

| Sale | Contribution a month | CAC that pays back in 11 months | Lifetime value |
| --- | --- | --- | --- |
| One store, sold direct | £6.99 (at 100 stores) | £77 | £115 (16.4 months); LTV/CAC 1.49 |
| A 25-seat BID deal | £6.85 per seat | £1,883 for the deal (24x a direct sale) | Not modelled |

Benchmarks: median CAC payback is 11 months for SaaS with annual contracts under $5k (16 months overall, 18 for vertical SaaS) [68]; median monthly churn is 6.1% for SaaS earning under $25 per account a month, a 16.4-month life [69]. BID deals of 50+ seats (over $5k a year) fall outside the 11-month band. Conclusion: £77 cannot pay for door-to-door selling, but a sponsor deal can. Sell through BIDs and councils, and let owners join on their own at the same price.

## 7. Go-to-market

The plan is to pilot one high street through its BID, convert, and repeat area by area. Shoreditch changes the first step:

- Shoreditch has no BID. No boundary in the GLA BID dataset (76 records, May 2025) contains Shoreditch High Street station, Brick Lane, Old Spitalfields Market or Hoxton Square, and none is in Hackney. The nearest edge, Aldgate BID, is 120-550 m from the Shoreditch, Brick Lane and Spitalfields points [39]. The dataset may be out of date: it says 70 London BIDs, British BIDs counts 81 [37].
- The neighbouring City BIDs levy only large premises: Aldgate Connect from £130,000 rateable value, Eastern City from £500,000 [40]. Small independents are not their members.

| Step | What | Partner | Exit test |
| --- | --- | --- | --- |
| 1. Interviews (weeks 1-3) | 15-20 owner interviews (script in 8.1), 3-5 sponsor interviews | Hackney Council night-time economy team; BID managers | 10+ owners agree to a dated pilot start (Q10) |
| 2. Sponsor | Shoreditch: Hackney Council, whose night-time strategy already tracks Shoreditch with HSDS data [22]. BID seat test: a town-centre BID whose levy covers small shops; first candidate to check is Angel Islington BID (46 streets, 550 businesses, about 2 km away, renewal ballot November 2026) [41] | One sponsor signed | Sponsor co-signs the success criteria |
| 3. Pilot (8 weeks) | 4 weeks of reports, then 4 weeks without prompts (8.2) | Sponsor introduces shops, hosts the kickoff, shares aggregated area data | Thresholds in 8.3 |
| 4. Convert | Sponsor buys seats at £96 a year, or owners pay £8 a month | Sponsor | 15%+ of activated shops paying, or a sponsor contract for 10+ seats |
| 5. Repeat by area | Next area adjacent to the last: rebuild the area simulation from OpenStreetMap, TfL and grid data; reuse the shared citizen and demand models | New BID or council | Each area's measured results recalibrate the shared models |

Sales notes:

- BIDs run lean (median 2.1 staff [36]), so the sponsor's job is introductions and a kickoff, not support.
- BIDs need benefits members can see: in one renewal consultation, 41% of 60 businesses did not know or were unsure what the BID delivered [54]. A weekly report per shop is visible.
- Local demand signal: Hackney's consultation results include calls for "an online data bank for business footfall data" [22].
- Budget timing: HSDS membership runs 1 April to 31 March [45] and BID plans are set per financial year [42], so pitch sponsors January-March for April starts (inference).
- Funding precedent: the GLA offered BIDs and other membership bodies up to £30,000 each to recruit 51+ businesses into an energy-efficiency programme (2022) [46].
- Data route: HSDS members may share aggregated insights with levy payers, and may sub-license data to contractors with GLA approval [45]. A sponsor could pass area footfall to us as its contractor, for calibration.

Why each area makes the next one cheaper: the analyst cost is shared by every shop in an area (6.4); measured outcomes of approved changes calibrate the shared demand model; and council aggregates need enough shops per street to stay anonymous.

## 8. Validation plan and PMF metrics

### 8.1 Interviews

15-20 owners, 30 minutes each, owner only, split across evening food and drink, daytime cafés, and off-licences or convenience stores. Rules: ask about specific past events, with no hypotheticals and no pitch before Q9 (YC [70]).

1. Walk me through last week: which hours and days were busiest and quietest, and how do you know?
2. When did you last change your opening hours or days? What triggered it, and how did you decide?
3. What is the hardest part of deciding whether to stay open late, or to open on a quiet day?
4. Tell me about the last energy bill or contract renewal you dealt with. What surprised you, and what did you do next?
5. What have you tried to cut energy costs (switching off lights, signs or equipment, LEDs, a broker, a free audit, a supplier app)? How did you know whether it worked?
6. Which numbers do you check every week (till or card reports, covers, footfall, bills)? What don't you like about them?
7. If a weekly note told you to close an hour earlier on Tuesdays, or dim the window lights after 10pm, what evidence would you need before acting? What would make you ignore it?
8. What would you not want to share (till data, meter data), and with whom (the BID, the council, your landlord, other shops)? What would you need in writing?
9. [After showing one sample report] At what monthly price per store would this be so cheap you would doubt it? A bargain? Getting expensive, but worth considering? Too expensive to consider?
10. Will you join a free 4-week pilot starting [date], connect your meter and till data, and spend 10 minutes a week on the report? Who else on your street should we talk to?

A yes to Q10 with a start date and an introduction counts as a commitment; "yes, but later" counts as a no. Sponsor interviews ask what area data they buy today, from which budget line, what members ask for, and what data-sharing terms they need.

### 8.2 Pilot design (4 weeks, free)

| Week | What happens |
| --- | --- |
| -2 to 0 | Recruit 30-40 ideal-customer shops per wave through the sponsor. Written consent for each data source. Check the meter type; connect half-hourly meter data and the hourly till export; build a 4-week baseline from history |
| 1-4 | Monday report (1-3 changes to hours or lighting, expected extra customers, £ a week saved, confidence, cited evidence, Approve or Reject); Thursday check-in; log what was implemented |
| End of week 4 | Sean Ellis survey; repeat the Q9 price questions; paid offer at £8 per store per month, a price fixed before the pilot |
| 5-8 | Reports continue with no prompting, to measure retention |
| 9 | Paid service starts |

Compute is not a constraint: 120 shops for 8 weeks costs about USD 120 in LLM spend at the team projection (derived). Recruitment and onboarding time are the real costs.

### 8.3 Metrics and pass thresholds

| Metric | Definition | Pass | Basis |
| --- | --- | --- | --- |
| Activation | Data connected and first report opened within 7 days, over shops recruited | 60%+ | Twice the SaaS median of 30% [74], since onboarding is assisted (design target) |
| Weekly opens | Shops opening that week's report, over activated shops | 60%+ every week | Design target |
| Approval | Changes approved, over changes suggested | 30%+, and 1+ approved change per active shop by week 4 | Design target |
| Implementation | Approved changes confirmed by the meter load shape, till hours or a photo | 50%+ of approvals | Design target |
| Energy result | Difference-in-differences on half-hourly kWh: changed half-hours against the shop's unchanged days and against shops that did not adopt | Cohort saving above zero (95% CI excludes zero); 50%+ of changes inside the report's stated range | Design target |
| Visits result | Till transactions in the changed hours against baseline, adjusted for area footfall | Extra customers at least 50% of the predicted median | Design target |
| PMF score (Sean Ellis) | "Very disappointed" if they could no longer use it, among shops that opened 2+ reports in the last 2 weeks | 40% or more | Ellis benchmark; directional from about 40 respondents [71] |
| Retention | Activated shops that open 1+ report and decide 1+ suggestion in weeks 5-8, unprompted | 60%+ (80%+ is great) | SMB SaaS 6-month benchmark [72]; our window is shorter, so this is an early signal |
| Conversion | Activated shops paying £8 within 14 days of pilot end, or a sponsor contract for 10+ seats | 15%+ | Free-trial "great" is 15-25% within 6 months [73]; in the Carbon Trust trial, 83% of 300 SMEs offered the paid service kept it (2006; larger sites, £242-£936 a year) [6] |
| Objections | Reject reasons, trust objections, refusals per data source | Tracked | - |

Sample size (derived): about 40 qualifying respondents give a directional Ellis score [71]. Shops to recruit = 40 / (activation x share opening 2+ reports x survey response rate). At assumed rates of 0.6 x 0.8 x 0.7 that is 119; at 0.8 x 0.9 x 0.8, 70. One 30-shop wave cannot reach 40, so run 2-3 waves (Shoreditch with Hackney, then a BID area), or report the score as directional.

Decision rule (design): if the PMF score, retention and conversion all pass, open the next area. If the score is under 40% but retention is 60%+, rebuild for the segment that answered "very disappointed". If retention is under 60%, problem-solution fit is not shown: go back to interviews.

## 9. Risks and mitigations

| Risk | Evidence | Mitigation |
| --- | --- | --- |
| Accuracy: predicted extra customers are not validated | The demand calibration runs on labelled placeholder shapes until Popular Times data is bought [76]; the savings rates come from a 2004-06 trial of much larger sites [6] | Price on energy alone (6.1); show confidence and evidence; the owner approves every change; measure every approved change (8.3) |
| Savings below the price | At the 3% data-only rate a median shop saves £6.90 a month, below £8 (6.1) | Lead with hospitality (positive even at 3%); target late-trading, above-median sites; sponsor-paid seats |
| Willingness to pay | Stated willingness to pay for SME energy tools was £50-£500 a year, in free pilots [20]; Help to Grow: Digital redeemed under 1,000 vouchers at 50% off, against a design for 100,000 SMEs [64] | Price below a month of savings at the 5% trial rate (6.1); let sponsors pay; set the paid price from Q9 before the pilot |
| Free alternatives | DESNZ tool free for 525+ hospitality SMEs [5]; British Gas Energy360 free [58]; £6,000 of free GLA support per business [47] | Sell weekly priced decisions on hours and lighting, not a dashboard; the free tools show the savings exist |
| Copy risk | Square AI free in the UK since Feb 2026 [60]; Deputy sells demand forecasting [61] | Shared area simulation, data firewall and per-store outcome history (section 5); move area by area quickly |
| Trust and privacy | Data security is UK firms' second AI worry (33%), after not understanding AI (38%); accuracy 23% [19] | Written consent per data source; a shop sees only its own data plus area figures from at least 5 shops; sponsors see cohort aggregates only; deletion on exit; refusal rate tracked |
| Council use for enforcement | HSDS lists "assessing footfall around nightlife businesses for licensing decisions" among member uses [45] | Refused by design: the contract bars use for licensing, business rates or enforcement; councils get anonymised aggregates only, never premises-level data |
| Competition law | Competing shops share one area model | No shop sees another's data; advice is per store and never coordinates hours or prices between competitors; aggregates only above a minimum shop count; legal review before phase 2 |
| No BID in Shoreditch | No BID boundary covers it [39]; nearby City BIDs exclude small premises [40] | Hackney Council as the Shoreditch sponsor; BID seat test in a BID whose levy covers small shops (candidate: Angel Islington [41]) |
| Council budget overlap | 21 of 33 London councils already subscribe to HSDS [45] | Sell what HSDS lacks (energy and lighting hours tied to shop response) at £15k, below its £20k list price |
| Measurement access | 67% of small-site meters are smart or advanced [4], but the route to their half-hourly data was not checked | Check meter type and consent route at onboarding; leave out shops that cannot be measured |
| Unit cost drift | One iteration measured; the weekly cost is projected; the batch discount is assumed [75] | Keep store agents on the Batch API; spend caps per session; re-measure in the overnight run |
| Churn | Median monthly churn of 6.1% for low-revenue SaaS accounts [69] | Annual sponsor invoices; show £ saved every week |

Not yet verified:

- Willingness to pay at £8 per store per month: no direct survey; Q9 sets it.
- Extra customers from changed hours: simulated only, on placeholder calibration.
- BIDs buying software seats for members: no precedent found. BIDs buy area data and share reports.
- Whether a BID covering Shoreditch exists or is proposed: the GLA dataset (May 2025) shows none; confirm with Hackney Council.
- The local independent share of retail sites: no checked source; the London ratio of 76.2% is a proxy.
- Shoreditch site counts: inflated by registered offices.
- Access to half-hourly meter data for small sites.
- The weekly 10-iteration LLM cost: only one iteration was measured.
- Whether 2004-06 savings rates hold for today's micro sites.

## 10. Sources

Energy prices and use

1. Prices of fuels purchased by non-domestic consumers in the UK, QEP tables 3.4.1-3.4.2. DESNZ, 29 Sep 2026. https://assets.publishing.service.gov.uk/media/6ab543da997a4b2950cceedc/table_341.xlsx
2. Non-domestic National Energy Efficiency Data-Framework 2026: supporting data tables (Table 14A). DESNZ, 30 Sep 2026. https://assets.publishing.service.gov.uk/media/6abbbe7a3239bb3cc19f5192/nd-need-2026-supporting-data.xlsx
3. Energy Consumption in the UK 2026: end use tables (Table U6). DESNZ, 24 Sep 2026. https://assets.publishing.service.gov.uk/media/6aac067444ec1aa417346c38/ECUK_2026_End_Use_tables.xlsx
4. Smart meters in Great Britain, quarterly update June 2026: statistical bulletin. DESNZ, 27 Aug 2026. https://www.gov.uk/government/statistics/smart-meters-in-great-britain-quarterly-update-june-2026/smart-meters-in-great-britain-quarterly-update-june-2026-statistical-bulletin
5. Pubs, restaurants and hotels slash bills with energy saving tool. DESNZ, 17 Mar 2026. https://www.gov.uk/government/news/pubs-restaurants-and-hotels-slash-bills-with-energy-saving-tool
6. Advanced metering for SMEs: carbon and cost savings (full report). Carbon Trust, May 2007 (trial 2004-06). https://www.carbontrust.com/sites/default/files/documents/resource/public/Advanced%20Metering%20For%20SMEs%20-%20REPORT.pdf

Business surveys and owner evidence

7. Business insights and impact on the UK economy: 8 October 2026 (BICS wave 165). ONS, 8 Oct 2026. https://www.ons.gov.uk/businessindustryandtrade/business/businessservices/bulletins/businessinsightsandimpactontheukeconomy/8october2026
8. Business insights and impact on the UK economy: 2 July 2026 (BICS wave 159). ONS, 2 Jul 2026. https://www.ons.gov.uk/businessindustryandtrade/business/businessservices/bulletins/businessinsightsandimpactontheukeconomy/2july2026
9. Food and drink service firms are most likely to cut trading to tackle energy costs. ONS, 14 Nov 2022. https://www.ons.gov.uk/businessindustryandtrade/business/businessservices/articles/foodanddrinkservicefirmsaremostlikelytocuttradingtotackleenergycosts/2022-11-14
10. Businesses' experiences of the energy market 2023: main research report. Ofgem (IFF Research), Mar 2024. https://www.ofgem.gov.uk/sites/default/files/2024-03/Businesses%27%20experiences%20of%20the%20energy%20market%202023%20-%20Main%20Research%20Report.pdf
11. One in four small firms plan to close, downsize, or restructure if energy bills relief ends in April next year. Federation of Small Businesses, 23 Nov 2022. https://www.fsb.org.uk/media-centre/press-release/one-in-four-small-firms-plan-to-close-downsize-or-restructure-if-energy-bills-re-MCHKANLX6ZLFGDBIBJYEUB4AWRRQ
12. Hospitality energy bills to almost double as support falls away. UKHospitality, 31 Jan 2023. https://www.ukhospitality.org.uk/hospitality-energy-bills-to-almost-double-as-support-falls-away/
13. NICs rise to hit hospitality employment and investment. Restaurant Online (survey by CGA by NIQ for UKHospitality, BBPA, BII, Hospitality Ulster), 25 Feb 2025. https://www.restaurantonline.co.uk/Article/2025/02/25/rise-in-national-insurance-contributions-to-hit-hospitality-employment-and-investment
14. Three quarters of small F&B operators have put up prices amid surging costs. The Caterer, 26 May 2026. https://www.thecaterer.com/news/three-quarters-of-small-fb-operators-have-put-up-prices-amid-surging-costs
15. Why is nobody talking about energy prices??? UK Business Forums (owner post), 15 Aug 2023. https://www.ukbusinessforums.co.uk/threads/why-is-nobody-talking-about-energy-prices.423455/
16. News article on small businesses and the energy crisis (headline not captured). The Big Issue, 17 Aug 2022. https://www.bigissue.com/news/employment/energy-crisis-small-businesses-price-cap-close/
17. 'Closing on Mondays for the first time in 11 years': East End businesses cutting down energy costs. Roman Road London, 13 Oct 2022. https://towerhamletsslice.co.uk/romanroad?p=35898
18. Brick Lane midnight curfew could destroy businesses, say restaurant owners. The Caterer, 6 Feb 2014. https://www.thecaterer.com/news/brick-lane-midnight-curfew-could-destroy-businesses-say-restaurant-owners
19. What UK businesses think about AI and who they trust. Moneypenny, updated 6 Mar 2026 (fieldwork Apr-May 2025, n=750). https://resources.moneypenny.com/blog/what-uk-businesses-think-about-ai-and-who-they-trust
20. NDSEMIC Insights for Innovators: developing smart energy management services for SMEs. BEIS (Carbon Trust with Ipsos MORI), Nov 2020. https://assets.publishing.service.gov.uk/media/5fa92415d3bf7f03aef812b7/insights-for-innovators.pdf

Night-time economy and high streets

21. London at Night: an updated evidence base for a 24 hour city. GLA Economics, Mar 2024. https://data.london.gov.uk/download/london-at-night--research-and-analysis/5311efaa-47c8-4664-a188-09e8763ae678/London-at-Night-Update-2024%2520%2528FOR%2520PDF%2529.pdf
22. Evening and Night time Strategy Update. London Borough of Hackney, Feb 2026 (PDF dated 27 Feb 2026). https://civico.net/hackney/documents/74236817/download
23. Night Time Enterprise Zones evaluation: full report. Greater London Authority, Feb 2024. https://www.london.gov.uk/sites/default/files/2024-02/240228_NTEZ-Full-Report.pdf
24. UK retail footfall falls 2.9 percent in September ahead of Budget (BRC-Sensormatic data). FashionUnited, 9 Oct 2026. https://fashionunited.uk/news/retail/uk-retail-footfall-falls-2-9-percent-in-september-ahead-of-budget/2026100990778
25. The high street isn't doomed - just look at London. Centre for Cities (Oscar Selby), 4 Dec 2025; the median suburban figure is from the underlying report, Follow the money (Dec 2025). https://www.centreforcities.org/blog/the-high-street-isnt-doomed-just-look-at-london/

Lighting rules

26. Arrêté du 25 janvier 2013 relatif à l'éclairage nocturne des bâtiments non résidentiels. Légifrance, JORF 30 Jan 2013 (in force 1 Jul 2013; repealed 29 Dec 2018). https://www.legifrance.gouv.fr/loda/id/JORFTEXT000027003910
27. Arrêté du 27 décembre 2018 relatif à la prévention, à la réduction et à la limitation des nuisances lumineuses. Légifrance, JORF 28 Dec 2018 (in force at 15 Oct 2026). https://www.legifrance.gouv.fr/loda/id/JORFTEXT000037864346
28. Question écrite n° 32959 (14e législature), ministerial answer. Assemblée nationale, JO 29 Oct 2013. https://www.assemblee-nationale.fr/dyn/14/questions/QANR5L14QE32959.pdf
29. Décret n° 2022-1294 du 5 octobre 2022 (extinction des publicités et enseignes lumineuses). Légifrance, JORF 6 Oct 2022. https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000046368520
30. Lighting Supplementary Planning Document. City of London Corporation, adopted Oct 2023. https://www.cityoflondon.gov.uk/assets/Services-Environment/lighting-spd-2023.pdf

Market counts

31. UK Business Counts - local units by industry and employment size band (NM_141_1): UK, England, London, Hackney, Tower Hamlets, Islington, City of London. ONS (IDBR) via Nomis, released 24 Sep 2026 (snapshot 13 Mar 2026). https://www.nomisweb.co.uk/api/v01/dataset/NM_141_1.data.csv?geography=K02000001,E92000001,E12000007,E09000012,E09000030,E09000019,E09000001&date=latest&industry=146800696,134273829,134273830,134273831,134274029,134274030,146800687,138416743,138416751,138416757,142606808,142606809,142606810,142606811,142606812,142606813,142606814,142606815&employment_sizeband=0,10,1,2,20,30,40&legal_status=0&measures=20100&select=date_name,geography_name,industry_name,employment_sizeband_name,obs_value
32. UK Business Counts - local units (NM_141_1): Shoreditch and five fringe MSOAs. ONS (IDBR) via Nomis, released 24 Sep 2026; MSOA names from the House of Commons Library. https://www.nomisweb.co.uk/api/v01/dataset/NM_141_1.data.csv?geography=E02007111,E02007110,E02000370,E02000872,E02000878,E02000576&date=latest&industry=146800696,134273829,134273830,134273831,134274030,146800687,138416743,138416757,142606809,142606814,142606815&employment_sizeband=0,10,20,30,40&legal_status=0&measures=20100&select=date_name,geography_name,geography_code,industry_name,employment_sizeband_name,obs_value
33. UK Business Counts - enterprises by industry and employment size band (NM_142_1): UK and London. ONS (IDBR) via Nomis, released 24 Sep 2026. https://www.nomisweb.co.uk/api/v01/dataset/NM_142_1.data.csv?geography=K02000001,E12000007&date=latest&industry=146800696,134273829,134273830,134273831,134274029,134274030,146800687,138416743,138416757,142606809,142606814,142606815&employment_sizeband=0,10,20,30,40&legal_status=0&measures=20100&select=date_name,geography_name,industry_name,employment_sizeband_name,obs_value
34. Food and beverage serving activities by SME size band within regions of the UK (ad hoc 3011, AH1746). ONS, 9 Sep 2025 (data Mar 2024). https://www.ons.gov.uk/businessindustryandtrade/business/activitysizeandlocation/adhocs/3011foodandbeverageservingactivitiesbysmesizebandwithinregionsoftheuk
35. The Local Shop Report 2026. Association of Convenience Stores, Sep 2026. https://cdn.acs.org.uk/public/ACS%20Local%20Shop%20Report%202026.pdf

BIDs, councils and area data

36. Annual BID Survey and Report 2025 (19th National BIDs Survey). British BIDs, Nov 2025 (data at Sep 2025). https://british-bids.files.svdcdn.com/production/publications/Annual-BID-Survey-and-Report-2025.pdf?dm=1762792757
37. The 2026 BIDs Spring Report. British BIDs, 30 Mar 2026 (data at 3 Mar 2026). https://british-bids.files.svdcdn.com/production/publications/2026-Spring-Report.pdf
38. Future of BIDs in Bexley (citing the 2022 British BIDs National Survey). London Borough of Bexley, Sep 2023. https://bexley.moderngov.co.uk/documents/s110728/Future%20of%20BIDs%20in%20Bexley.pdf
39. London Plan Business Improvement Districts (dataset, KML). Greater London Authority, updated 12 May 2025. https://data.london.gov.uk/dataset/london-plan-business-improvement-districts
40. Business Improvement Districts in the City. City of London Corporation, updated 11 Aug 2026. https://www.cityoflondon.gov.uk/services/business-rates/business-improvement-districts-in-the-city
41. Angel Islington BID, homepage. Angel Islington BID, accessed 15 Oct 2026. https://www.angelislington.london/
42. Approved Business Plan 2026/27. Team London Bridge, Jul 2026. https://www.teamlondonbridge.co.uk/wp-content/uploads/2026/07/TLB-Approved-Business-Plan-2026_27.pdf
43. South Bank BID partners with High Streets Data Service. South Bank BID, 31 Aug 2023. https://southbankbid.co.uk/news/south-bank-bid-partners-with-high-streets-data-service
44. First insight-led quarterly report launched. South Bank BID, 28 Feb 2025. https://southbankbid.co.uk/news/first-insight-led-quarterly-report-launched
45. High Streets Data Service 2026/27 Membership Prospectus. Greater London Authority, posted 5 Sep 2026. https://data.london.gov.uk/download/attachment/webpage/we1ln/2026-09-05T21:39:53/HSDS_Membership_Prospectus_2026.pdf
46. The Mayor's Business Climate Challenge: prospectus for partners. Greater London Authority, 18 Mar 2022. https://www.london.gov.uk/print/pdf/node/82081
47. Mayor supports more than 200 London businesses in cutting energy use and carbon emissions. Greater London Authority, 29 Nov 2023. https://www.london.gov.uk/Mayor%20supports%20more%20than%20200%20London%20businesses%20in%20cutting%20energy%20use%20and%20carbon%20emissions
48. Local government structure and elections. MHCLG (GOV.UK), updated 1 Apr 2023. https://www.gov.uk/guidance/local-government-structure-and-elections
49. Local government (explainer). Institute for Government, updated 9 Aug 2022. https://www.instituteforgovernment.org.uk/explainer/local-government
50. Membership to Data Service (2026/S 000-004950). London Borough of Bexley via Find a Tender, 20 Jan 2026. https://www.find-tender.service.gov.uk/Notice/004950-2026
51. Town Centre Footfall Data Collection and Evaluation (contract award). Sefton Council via Contracts Finder, 1 Sep 2023. https://www.contractsfinder.service.gov.uk/Notice/dfe2a132-256d-49bf-981b-ce4f0ab8d513
52. Footfall Monitoring Solution (contract award). Durham County Council via Contracts Finder, 16 Sep 2024. https://www.contractsfinder.service.gov.uk/Notice/30fa9435-f89f-4875-96e7-78aaf0127b5b
53. Awarded contracts matching "footfall" (for example Milton Keynes, £2,650 over 2 years; North Yorkshire, £78,230 over 2 years). Contracts Finder, searched 15 Oct 2026. https://www.contractsfinder.service.gov.uk/Search
54. Appendix 4: Summary of Levy Payer Consultation (Wood Green BID renewal). London Borough of Haringey, 2022. https://www.minutes.haringey.gov.uk/documents/s135976/Appendix%204%20-%20Summary%20of%20Levy%20Payer%20Consultation.pdf

Competitors and software prices

55. G-Cloud 14 pricing - MRI OnLocation Footfall Analytics. MRI Software via the UK Digital Marketplace, May 2024. https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-14/documents/709203/415925730248610-pricing-document-2024-05-03-1541.pdf
56. G-Cloud 15 BT price card for BT Active Intelligence. British Telecommunications plc via the UK Digital Marketplace, 13 Jan 2026. https://assets.applytosupply.digitalmarketplace.service.gov.uk/g-cloud-15/documents/92553/361978895476802-pricing-document-2026-01-13-1527.pdf
57. Beauclair, homepage. Beauclair, accessed 15 Oct 2026. https://beauclairdata.co.uk/
58. Energy360 DataView. British Gas Business, accessed 15 Oct 2026. https://britishgas.co.uk/business/smart-meters/energy360
59. Square for Restaurants pricing (UK). Square, accessed 15 Oct 2026. https://squareup.com/gb/en/point-of-sale/restaurants/pricing
60. Introducing Square AI: helping UK small businesses turn instinct into confident decisions. City AM (Square release), 10 Feb 2026. https://www.cityam.com/introducing-square-ai-helping-uk-small-businesses-turn-instinct-into-confident-decisions/
61. Pricing plans. Deputy, accessed 15 Oct 2026. https://www.deputy.com/pricing
62. Pricing plans (UK). Xero, accessed 15 Oct 2026. https://www.xero.com/uk/pricing-plans/
63. Lightspeed Restaurant pricing (UK). Lightspeed, accessed 15 Oct 2026. https://www.lightspeedhq.com/uk/pos/restaurant/pricing/
64. Final opportunity for businesses to access Help to Grow: Digital scheme. GOV.UK (BEIS), 15 Dec 2022. https://www.gov.uk/government/news/final-opportunity-for-businesses-to-access-help-to-grow-digital-scheme

Unit economics benchmarks

65. Claude API pricing. Anthropic, accessed 15 Oct 2026. https://platform.claude.com/docs/en/about-claude/pricing
66. Pricing. Vercel, accessed 15 Oct 2026. https://vercel.com/pricing
67. Pricing (UK). Stripe, accessed 15 Oct 2026. https://stripe.com/gb/pricing
68. CAC payback period benchmarks for SaaS (2026 SaaS and AI Performance Benchmarks). Aleph and Benchmarkit, 1 Jun 2026. https://www.getaleph.com/answers/cac-payback-period-saas-2026
69. What is a good customer churn rate? ChartMogul, 23 Feb 2022. https://chartmogul.com/blog/good-customer-churn-rate/

Validation methods

70. Startup School Week 1 recap: Kevin Hale and Eric Migicovsky. Y Combinator, 4 Sep 2019. https://ycombinator.com/blog/startup-school-week-1-recap-kevin-hale-and-eric-migicovsky
71. How Superhuman built an engine to find product/market fit. First Round Review, 13 Nov 2018 (updated 24 Oct 2024). https://review.firstround.com/how-superhuman-built-an-engine-to-find-product-market-fit/
72. What is good retention (issue 29). Lenny's Newsletter, 9 Jun 2020. https://www.lennysnewsletter.com/p/what-is-good-retention-issue-29
73. What is a good free-to-paid conversion rate. Lenny's Newsletter, 1 Aug 2023. https://www.lennysnewsletter.com/p/what-is-a-good-free-to-paid-conversion
74. What is a good activation rate. Lenny's Newsletter, 25 Oct 2022. https://www.lennysnewsletter.com/p/what-is-a-good-activation-rate

Project data

75. Claude cost ledger, session 58ab54fb42ce (52 rows). Smart City Sim, 15 Oct 2026. `runs/costs.jsonl`
76. Calibration status: placeholder demand shapes until Popular Times data is bought. Smart City Sim, 15 Oct 2026. `docs/DELIVERABLES.md` (build checklist) and `backend/pipeline/calibration_data.py`
