"""Country of origin, canonicalised.

Duty depends on origin, and origin arrives as free text: "China", "CN", "PRC",
"People's Republic of China". Matching those literally against Chapter 99's
country lists meant `CN` skipped the Section 301 duty and produced a
plausible, wrong, warning-free quote. Every origin is therefore reduced to an
ISO 3166-1 alpha-2 key on the way in, and an origin that cannot be resolved is
rejected rather than treated as "somewhere without remedies".

Chapter 99's own country names are canonicalised through the same table, since
the parsed text carries truncations such as "Bosnia" and "Trinidad".
"""
from __future__ import annotations

import re

# code | name | alpha-3 | aliases (;-separated)
_TABLE = """
AF|Afghanistan|AFG|
AL|Albania|ALB|
DZ|Algeria|DZA|
AS|American Samoa|ASM|
AD|Andorra|AND|
AO|Angola|AGO|
AI|Anguilla|AIA|
AQ|Antarctica|ATA|
AG|Antigua and Barbuda|ATG|Antigua
AR|Argentina|ARG|
AM|Armenia|ARM|
AW|Aruba|ABW|
AU|Australia|AUS|
AT|Austria|AUT|
AZ|Azerbaijan|AZE|
BS|Bahamas|BHS|The Bahamas
BH|Bahrain|BHR|
BD|Bangladesh|BGD|
BB|Barbados|BRB|
BY|Belarus|BLR|
BE|Belgium|BEL|
BZ|Belize|BLZ|
BJ|Benin|BEN|
BM|Bermuda|BMU|
BT|Bhutan|BTN|
BO|Bolivia|BOL|Plurinational State of Bolivia
BA|Bosnia and Herzegovina|BIH|Bosnia;Bosnia-Herzegovina
BW|Botswana|BWA|
BV|Bouvet Island|BVT|
BR|Brazil|BRA|
IO|British Indian Ocean Territory|IOT|
VG|British Virgin Islands|VGB|Virgin Islands, British
BN|Brunei|BRN|Brunei Darussalam
BG|Bulgaria|BGR|
BF|Burkina Faso|BFA|
BI|Burundi|BDI|
CV|Cabo Verde|CPV|Cape Verde
KH|Cambodia|KHM|
CM|Cameroon|CMR|
CA|Canada|CAN|
KY|Cayman Islands|CYM|
CF|Central African Republic|CAF|
TD|Chad|TCD|
CL|Chile|CHL|
CN|China|CHN|PRC;People's Republic of China;Peoples Republic of China;Mainland China
CX|Christmas Island|CXR|
CC|Cocos (Keeling) Islands|CCK|
CO|Colombia|COL|
KM|Comoros|COM|
CG|Congo|COG|Republic of the Congo;Congo-Brazzaville;Congo, Republic of the
CD|Democratic Republic of the Congo|COD|Democratic Republic;DR Congo;DRC;Congo, Democratic Republic of the;Congo-Kinshasa
CK|Cook Islands|COK|
CR|Costa Rica|CRI|
CI|Cote d'Ivoire|CIV|Ivory Coast;Côte d'Ivoire;Côte;Cote
HR|Croatia|HRV|
CU|Cuba|CUB|
CW|Curacao|CUW|Curaçao
CY|Cyprus|CYP|
CZ|Czech Republic|CZE|Czechia
DK|Denmark|DNK|
DJ|Djibouti|DJI|
DM|Dominica|DMA|
DO|Dominican Republic|DOM|
EC|Ecuador|ECU|
EG|Egypt|EGY|
SV|El Salvador|SLV|
GQ|Equatorial Guinea|GNQ|
ER|Eritrea|ERI|
EE|Estonia|EST|
SZ|Eswatini|SWZ|Swaziland
ET|Ethiopia|ETH|
FK|Falkland Islands|FLK|Falkland Islands (Malvinas)
FO|Faroe Islands|FRO|
FJ|Fiji|FJI|
FI|Finland|FIN|
FR|France|FRA|
GF|French Guiana|GUF|
PF|French Polynesia|PYF|
TF|French Southern Territories|ATF|
GA|Gabon|GAB|
GM|Gambia|GMB|The Gambia
GE|Georgia|GEO|
DE|Germany|DEU|
GH|Ghana|GHA|
GI|Gibraltar|GIB|
GR|Greece|GRC|
GL|Greenland|GRL|
GD|Grenada|GRD|
GP|Guadeloupe|GLP|
GU|Guam|GUM|
GT|Guatemala|GTM|
GG|Guernsey|GGY|
GN|Guinea|GIN|
GW|Guinea-Bissau|GNB|
GY|Guyana|GUY|
HT|Haiti|HTI|
HM|Heard Island and McDonald Islands|HMD|
VA|Holy See|VAT|Vatican;Vatican City
HN|Honduras|HND|
HK|Hong Kong|HKG|Hong Kong SAR
HU|Hungary|HUN|
IS|Iceland|ISL|
IN|India|IND|
ID|Indonesia|IDN|
IR|Iran|IRN|Islamic Republic of Iran
IQ|Iraq|IRQ|
IE|Ireland|IRL|
IM|Isle of Man|IMN|
IL|Israel|ISR|
IT|Italy|ITA|
JM|Jamaica|JAM|
JP|Japan|JPN|
JE|Jersey|JEY|
JO|Jordan|JOR|
KZ|Kazakhstan|KAZ|
KE|Kenya|KEN|
KI|Kiribati|KIR|
KP|North Korea|PRK|Korea, North;Democratic People's Republic of Korea;DPRK
KR|South Korea|KOR|Korea;Korea, South;Republic of Korea;Korea (South)
XK|Kosovo|XKX|
KW|Kuwait|KWT|
KG|Kyrgyzstan|KGZ|Kyrgyz Republic
LA|Laos|LAO|Lao People's Democratic Republic;Lao PDR
LV|Latvia|LVA|
LB|Lebanon|LBN|
LS|Lesotho|LSO|
LR|Liberia|LBR|
LY|Libya|LBY|
LI|Liechtenstein|LIE|
LT|Lithuania|LTU|
LU|Luxembourg|LUX|
MO|Macau|MAC|Macao;Macao SAR
MG|Madagascar|MDG|
MW|Malawi|MWI|
MY|Malaysia|MYS|
MV|Maldives|MDV|
ML|Mali|MLI|
MT|Malta|MLT|
MH|Marshall Islands|MHL|
MQ|Martinique|MTQ|
MR|Mauritania|MRT|
MU|Mauritius|MUS|
YT|Mayotte|MYT|
MX|Mexico|MEX|
FM|Micronesia|FSM|Federated States of Micronesia
MD|Moldova|MDA|Republic of Moldova
MC|Monaco|MCO|
MN|Mongolia|MNG|
ME|Montenegro|MNE|
MS|Montserrat|MSR|
MA|Morocco|MAR|
MZ|Mozambique|MOZ|
MM|Myanmar|MMR|Burma
NA|Namibia|NAM|
NR|Nauru|NRU|
NP|Nepal|NPL|
NL|Netherlands|NLD|Holland;The Netherlands
NC|New Caledonia|NCL|
NZ|New Zealand|NZL|
NI|Nicaragua|NIC|
NE|Niger|NER|
NG|Nigeria|NGA|
NU|Niue|NIU|
NF|Norfolk Island|NFK|
MK|North Macedonia|MKD|Macedonia
MP|Northern Mariana Islands|MNP|
NO|Norway|NOR|
OM|Oman|OMN|
PK|Pakistan|PAK|
PW|Palau|PLW|
PS|Palestine|PSE|State of Palestine;West Bank
PA|Panama|PAN|
PG|Papua New Guinea|PNG|
PY|Paraguay|PRY|
PE|Peru|PER|
PH|Philippines|PHL|
PN|Pitcairn Islands|PCN|Pitcairn
PL|Poland|POL|
PT|Portugal|PRT|
PR|Puerto Rico|PRI|
QA|Qatar|QAT|
RE|Reunion|REU|Réunion
RO|Romania|ROU|
RU|Russia|RUS|Russian Federation
RW|Rwanda|RWA|
BL|Saint Barthelemy|BLM|Saint Barthélemy
SH|Saint Helena|SHN|
KN|Saint Kitts and Nevis|KNA|St. Kitts and Nevis;St Kitts and Nevis
LC|Saint Lucia|LCA|St. Lucia;St Lucia
MF|Saint Martin|MAF|
PM|Saint Pierre and Miquelon|SPM|
VC|Saint Vincent and the Grenadines|VCT|St. Vincent and the Grenadines;St Vincent
WS|Samoa|WSM|
SM|San Marino|SMR|
ST|Sao Tome and Principe|STP|São Tomé and Príncipe
SA|Saudi Arabia|SAU|
SN|Senegal|SEN|
RS|Serbia|SRB|
SC|Seychelles|SYC|
SL|Sierra Leone|SLE|
SG|Singapore|SGP|
SX|Sint Maarten|SXM|
SK|Slovakia|SVK|Slovak Republic
SI|Slovenia|SVN|
SB|Solomon Islands|SLB|
SO|Somalia|SOM|
ZA|South Africa|ZAF|
GS|South Georgia and the South Sandwich Islands|SGS|
SS|South Sudan|SSD|
ES|Spain|ESP|
LK|Sri Lanka|LKA|
SD|Sudan|SDN|
SR|Suriname|SUR|
SJ|Svalbard and Jan Mayen|SJM|
SE|Sweden|SWE|
CH|Switzerland|CHE|
SY|Syria|SYR|Syrian Arab Republic
TW|Taiwan|TWN|Chinese Taipei;Republic of China;Taiwan, Province of China
TJ|Tajikistan|TJK|
TZ|Tanzania|TZA|United Republic of Tanzania
TH|Thailand|THA|
TL|Timor-Leste|TLS|East Timor
TG|Togo|TGO|
TK|Tokelau|TKL|
TO|Tonga|TON|
TT|Trinidad and Tobago|TTO|Trinidad
TN|Tunisia|TUN|
TR|Turkey|TUR|Turkiye;Türkiye
TM|Turkmenistan|TKM|
TC|Turks and Caicos Islands|TCA|
TV|Tuvalu|TUV|
UG|Uganda|UGA|
UA|Ukraine|UKR|
AE|United Arab Emirates|ARE|UAE
GB|United Kingdom|GBR|UK;Great Britain;Britain;England;Scotland;Wales;Northern Ireland
US|United States|USA|US;USA;U.S.;U.S.A.;America;United States of America
UM|United States Minor Outlying Islands|UMI|
UY|Uruguay|URY|
UZ|Uzbekistan|UZB|
VU|Vanuatu|VUT|
VE|Venezuela|VEN|Bolivarian Republic of Venezuela
VN|Vietnam|VNM|Viet Nam
VI|U.S. Virgin Islands|VIR|Virgin Islands, U.S.;US Virgin Islands
WF|Wallis and Futuna|WLF|
EH|Western Sahara|ESH|
YE|Yemen|YEM|
ZM|Zambia|ZMB|
ZW|Zimbabwe|ZWE|
"""

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def _norm(s: str) -> str:
    return _NON_ALNUM.sub(" ", s.lower()).strip()


_BY_ISO2: dict[str, str] = {}
_LOOKUP: dict[str, str] = {}

for _line in _TABLE.strip().splitlines():
    _code, _name, _a3, _aliases = _line.split("|")
    _BY_ISO2[_code] = _name
    for _key in [_code, _a3, _name, *[a for a in _aliases.split(";") if a]]:
        _LOOKUP.setdefault(_norm(_key), _code)

_CODES = frozenset(_BY_ISO2)


class UnknownCountry(ValueError):
    """The origin cannot be resolved to a country. Never guess: an unresolved
    origin would fall through to a quote that omits every country-specific
    remedy."""


def country_code(name: str | None) -> str | None:
    """ISO alpha-2 for a country name/code/alias, or None if unrecognised."""
    if not name:
        return None
    raw = name.strip()
    if len(raw) == 2 and raw.isalpha() and raw.upper() in _CODES:
        return raw.upper()
    return _LOOKUP.get(_norm(raw))


def require_country(name: str | None) -> str:
    code = country_code(name)
    if code is None:
        shown = (name or "").strip()[:60] or "(blank)"
        raise UnknownCountry(
            f"Unrecognised country of origin {shown!r}. Use the country name or "
            "its ISO code (for example China or CN)."
        )
    return code


def country_name(code: str) -> str:
    return _BY_ISO2[code]


# The twenty-seven member states, for Chapter 99 lines that say "a member state
# of the European Union" instead of naming countries.
EU_MEMBERS = (
    "Austria", "Belgium", "Bulgaria", "Croatia", "Cyprus", "Czech Republic",
    "Denmark", "Estonia", "Finland", "France", "Germany", "Greece", "Hungary",
    "Ireland", "Italy", "Latvia", "Lithuania", "Luxembourg", "Malta",
    "Netherlands", "Poland", "Portugal", "Romania", "Slovakia", "Slovenia",
    "Spain", "Sweden",
)
