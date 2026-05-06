// US city coordinates lookup — format: "city name,state abbreviation" → [lat, lng]
const CITIES: Record<string, [number, number]> = {
  // Alabama
  "birmingham,al":[33.5207,-86.8025],"montgomery,al":[32.3668,-86.2999],"huntsville,al":[34.7304,-86.5861],
  "mobile,al":[30.6954,-88.0399],"tuscaloosa,al":[33.2098,-87.5692],"hoover,al":[33.4054,-86.8114],
  // Alaska
  "anchorage,ak":[61.2181,-149.9003],"fairbanks,ak":[64.8378,-147.7164],"juneau,ak":[58.3005,-134.4197],
  // Arizona
  "phoenix,az":[33.4484,-112.0740],"tucson,az":[32.2226,-110.9747],"mesa,az":[33.4152,-111.8315],
  "scottsdale,az":[33.4942,-111.9261],"glendale,az":[33.5387,-112.1860],"gilbert,az":[33.3528,-111.7890],
  "chandler,az":[33.3062,-111.8413],"tempe,az":[33.4255,-111.9400],"peoria,az":[33.5806,-112.2374],
  "surprise,az":[33.6292,-112.3679],"yuma,az":[32.6927,-114.6277],"avondale,az":[33.4356,-112.3496],
  "flagstaff,az":[35.1983,-111.6513],"goodyear,az":[33.4353,-112.3576],"lake havasu city,az":[34.4839,-114.3225],
  "nogales,az":[31.3402,-110.9343],
  // Arkansas
  "little rock,ar":[34.7465,-92.2896],"fort smith,ar":[35.3859,-94.3985],"fayetteville,ar":[36.0626,-94.1574],
  "springdale,ar":[36.1867,-94.1288],"jonesboro,ar":[35.8423,-90.7043],
  // California
  "los angeles,ca":[34.0522,-118.2437],"san diego,ca":[32.7157,-117.1611],"san jose,ca":[37.3382,-121.8863],
  "san francisco,ca":[37.7749,-122.4194],"fresno,ca":[36.7378,-119.7871],"sacramento,ca":[38.5816,-121.4944],
  "long beach,ca":[33.7701,-118.1937],"oakland,ca":[37.8044,-122.2711],"bakersfield,ca":[35.3733,-119.0187],
  "anaheim,ca":[33.8366,-117.9143],"santa ana,ca":[33.7455,-117.8677],"riverside,ca":[33.9806,-117.3755],
  "stockton,ca":[37.9577,-121.2908],"irvine,ca":[33.6846,-117.8265],"chula vista,ca":[32.6401,-117.0842],
  "fremont,ca":[37.5485,-121.9886],"san bernardino,ca":[34.1083,-117.2898],"modesto,ca":[37.6391,-120.9969],
  "fontana,ca":[34.0922,-117.4352],"moreno valley,ca":[33.9425,-117.2297],"glendale,ca":[34.1425,-118.2551],
  "huntington beach,ca":[33.6603,-117.9992],"santa clarita,ca":[34.3917,-118.5426],"garden grove,ca":[33.7743,-117.9378],
  "oceanside,ca":[33.1959,-117.3795],"lancaster,ca":[34.6868,-118.1542],"elk grove,ca":[38.4088,-121.3716],
  "ontario,ca":[34.0633,-117.6509],"corona,ca":[33.8753,-117.5664],"palmdale,ca":[34.5794,-118.1165],
  "salinas,ca":[36.6777,-121.6555],"pomona,ca":[34.0553,-117.7520],"escondido,ca":[33.1192,-117.0864],
  "sunnyvale,ca":[37.3688,-122.0363],"torrance,ca":[33.8358,-118.3406],"pasadena,ca":[34.1478,-118.1445],
  "hayward,ca":[37.6688,-122.0808],"orange,ca":[33.7879,-117.8531],"fullerton,ca":[33.8704,-117.9242],
  "roseville,ca":[38.7521,-121.2880],"visalia,ca":[36.3302,-119.2921],"oxnard,ca":[34.1975,-119.1771],
  "concord,ca":[37.9779,-122.0311],"santa rosa,ca":[38.4404,-122.7141],"rancho cucamonga,ca":[34.1064,-117.5931],
  "ontario,ca":[34.0633,-117.6509],"vallejo,ca":[38.1041,-122.2566],"rialto,ca":[34.1064,-117.3703],
  "antioch,ca":[37.9963,-121.7805],"temecula,ca":[33.4936,-117.1484],"victorville,ca":[34.5361,-117.2912],
  "murrieta,ca":[33.5539,-117.2139],"richmond,ca":[37.9358,-122.3478],"santa clara,ca":[37.3541,-121.9552],
  "berkeley,ca":[37.8716,-122.2727],"el monte,ca":[34.0686,-118.0276],"downey,ca":[33.9401,-118.1331],
  "costa mesa,ca":[33.6411,-117.9187],"inglewood,ca":[33.9617,-118.3531],
  // Colorado
  "denver,co":[39.7392,-104.9903],"colorado springs,co":[38.8339,-104.8214],"aurora,co":[39.7294,-104.8319],
  "fort collins,co":[40.5853,-105.0844],"lakewood,co":[39.7047,-105.0814],"thornton,co":[39.8680,-104.9719],
  "arvada,co":[39.8028,-105.0875],"westminster,co":[39.8367,-105.0372],"pueblo,co":[38.2544,-104.6091],
  "boulder,co":[40.0150,-105.2705],"highlands ranch,co":[39.5597,-104.9697],"greeley,co":[40.4233,-104.7091],
  // Connecticut
  "bridgeport,ct":[41.1792,-73.1894],"new haven,ct":[41.3082,-72.9282],"hartford,ct":[41.7637,-72.6851],
  "stamford,ct":[41.0534,-73.5387],"waterbury,ct":[41.5582,-73.0515],"norwalk,ct":[41.1177,-73.4082],
  // Delaware
  "wilmington,de":[39.7447,-75.5484],"dover,de":[39.1582,-75.5244],
  // Florida
  "jacksonville,fl":[30.3322,-81.6557],"miami,fl":[25.7617,-80.1918],"tampa,fl":[27.9506,-82.4572],
  "orlando,fl":[28.5383,-81.3792],"st. petersburg,fl":[27.7676,-82.6403],"hialeah,fl":[25.8576,-80.2781],
  "tallahassee,fl":[30.4518,-84.2807],"fort lauderdale,fl":[26.1224,-80.1373],"port st. lucie,fl":[27.2939,-80.3503],
  "cape coral,fl":[26.5629,-81.9495],"pembroke pines,fl":[26.0076,-80.2963],"miramar,fl":[25.9860,-80.3228],
  "hollywood,fl":[26.0112,-80.1495],"gainesville,fl":[29.6516,-82.3248],"coral springs,fl":[26.2712,-80.2706],
  "clearwater,fl":[27.9659,-82.8001],"miami gardens,fl":[25.9420,-80.2456],"west palm beach,fl":[26.7153,-80.0534],
  "palm bay,fl":[28.0345,-80.5887],"lakeland,fl":[28.0395,-81.9498],"pompano beach,fl":[26.2379,-80.1248],
  "daytona beach,fl":[29.2108,-81.0228],"fort myers,fl":[26.6406,-81.8723],"pensacola,fl":[30.4213,-87.2169],
  "sarasota,fl":[27.3364,-82.5307],
  // Georgia
  "atlanta,ga":[33.7490,-84.3880],"savannah,ga":[32.0835,-81.0998],"augusta,ga":[33.4735,-82.0105],
  "columbus,ga":[32.4610,-84.9877],"macon,ga":[32.8407,-83.6324],"athens,ga":[33.9519,-83.3576],
  "sandy springs,ga":[33.9304,-84.3733],"roswell,ga":[34.0232,-84.3616],"albany,ga":[31.5785,-84.1557],
  "marietta,ga":[33.9526,-84.5499],"warner robins,ga":[32.6130,-83.6238],
  // Hawaii
  "honolulu,hi":[21.3069,-157.8583],"pearl city,hi":[21.3972,-157.9751],
  // Idaho
  "boise,id":[43.6150,-116.2023],"nampa,id":[43.5407,-116.5635],"meridian,id":[43.6121,-116.3915],
  "idaho falls,id":[43.4917,-112.0339],"pocatello,id":[42.8713,-112.4455],"twin falls,id":[42.5630,-114.4609],
  // Illinois
  "chicago,il":[41.8781,-87.6298],"aurora,il":[41.7606,-88.3201],"joliet,il":[41.5250,-88.0817],
  "naperville,il":[41.7508,-88.1535],"peoria,il":[40.6936,-89.5890],"rockford,il":[42.2711,-89.0940],
  "elgin,il":[42.0354,-88.2826],"springfield,il":[39.7817,-89.6501],"waukegan,il":[42.3636,-87.8448],
  "cicero,il":[41.8456,-87.7539],"champaign,il":[40.1164,-88.2434],"bloomington,il":[40.4842,-88.9937],
  "decatur,il":[39.8403,-88.9548],"evanston,il":[42.0450,-87.6877],
  // Indiana
  "indianapolis,in":[39.7684,-86.1581],"fort wayne,in":[41.0793,-85.1394],"evansville,in":[37.9716,-87.5711],
  "south bend,in":[41.6764,-86.2520],"carmel,in":[39.9784,-86.1180],"fishers,in":[39.9556,-86.0133],
  "hammond,in":[41.5831,-87.5001],"gary,in":[41.5934,-87.3470],"muncie,in":[40.1934,-85.3863],
  "terre haute,in":[39.4667,-87.4139],"lafayette,in":[40.4167,-86.8753],
  // Iowa
  "des moines,ia":[41.5868,-93.6250],"cedar rapids,ia":[41.9779,-91.6656],"davenport,ia":[41.5236,-90.5776],
  "sioux city,ia":[42.4999,-96.4003],"iowa city,ia":[41.6611,-91.5302],"waterloo,ia":[42.4928,-92.3427],
  // Kansas
  "wichita,ks":[37.6872,-97.3301],"overland park,ks":[38.9822,-94.6708],"kansas city,ks":[39.1142,-94.6275],
  "olathe,ks":[38.8814,-94.8191],"topeka,ks":[39.0473,-95.6752],"lawrence,ks":[38.9717,-95.2353],
  // Kentucky
  "louisville,ky":[38.2527,-85.7585],"lexington,ky":[38.0406,-84.5037],"bowling green,ky":[36.9685,-86.4808],
  "owensboro,ky":[37.7719,-87.1112],"covington,ky":[39.0837,-84.5086],"hopkinsville,ky":[36.8656,-87.4886],
  // Louisiana
  "new orleans,la":[29.9511,-90.0715],"baton rouge,la":[30.4515,-91.1871],"shreveport,la":[32.5252,-93.7502],
  "lafayette,la":[30.2241,-92.0198],"lake charles,la":[30.2266,-93.2174],"kenner,la":[29.9941,-90.2417],
  "bossier city,la":[32.5160,-93.7321],"monroe,la":[32.5093,-92.1193],
  // Maine
  "portland,me":[43.6591,-70.2568],"lewiston,me":[44.1004,-70.2148],"augusta,me":[44.3106,-69.7795],
  // Maryland
  "baltimore,md":[39.2904,-76.6122],"silver spring,md":[38.9912,-77.0262],"annapolis,md":[38.9784,-76.4922],
  "rockville,md":[39.0840,-77.1528],"bethesda,md":[38.9807,-77.1003],"gaithersburg,md":[39.1434,-77.2014],
  // Massachusetts
  "boston,ma":[42.3601,-71.0589],"worcester,ma":[42.2626,-71.8023],"springfield,ma":[42.1015,-72.5898],
  "lowell,ma":[42.6334,-71.3162],"cambridge,ma":[42.3736,-71.1097],"new bedford,ma":[41.6362,-70.9342],
  "brockton,ma":[42.0834,-71.0184],"quincy,ma":[42.2529,-71.0023],"lynn,ma":[42.4668,-70.9495],
  "fall river,ma":[41.7015,-71.1550],
  // Michigan
  "detroit,mi":[42.3314,-83.0458],"grand rapids,mi":[42.9634,-85.6681],"warren,mi":[42.5145,-83.0146],
  "sterling heights,mi":[42.5803,-83.0302],"lansing,mi":[42.7325,-84.5555],"ann arbor,mi":[42.2808,-83.7430],
  "flint,mi":[43.0125,-83.6875],"dearborn,mi":[42.3223,-83.1763],"livonia,mi":[42.3684,-83.3527],
  "clinton township,mi":[42.5870,-82.9194],"pontiac,mi":[42.6389,-83.2910],"kalamazoo,mi":[42.2917,-85.5872],
  "troy,mi":[42.6064,-83.1498],"saginaw,mi":[43.4195,-83.9508],"muskegon,mi":[43.2342,-86.2484],
  // Minnesota
  "minneapolis,mn":[44.9778,-93.2650],"st. paul,mn":[44.9537,-93.0900],"rochester,mn":[44.0121,-92.4802],
  "duluth,mn":[46.7867,-92.1005],"bloomington,mn":[44.8408,-93.3772],"brooklyn park,mn":[45.0941,-93.3725],
  "plymouth,mn":[45.0105,-93.4555],"maple grove,mn":[45.0725,-93.4558],
  // Mississippi
  "jackson,ms":[32.2988,-90.1848],"gulfport,ms":[30.3674,-89.0928],"biloxi,ms":[30.3960,-88.8853],
  "hattiesburg,ms":[31.3271,-89.2903],"meridian,ms":[32.3643,-88.7037],
  // Missouri
  "kansas city,mo":[39.0997,-94.5786],"st. louis,mo":[38.6270,-90.1994],"springfield,mo":[37.2153,-93.2982],
  "columbia,mo":[38.9517,-92.3341],"independence,mo":[39.0911,-94.4155],"lee's summit,mo":[38.9108,-94.3819],
  "o'fallon,mo":[38.8106,-90.6998],"jefferson city,mo":[38.5767,-92.1735],"joplin,mo":[37.0842,-94.5133],
  "st. joseph,mo":[39.7675,-94.8467],
  // Montana
  "billings,mt":[45.7833,-108.5007],"missoula,mt":[46.8721,-113.9940],"great falls,mt":[47.5002,-111.3008],
  "bozeman,mt":[45.6770,-111.0429],"butte,mt":[46.0038,-112.5348],"helena,mt":[46.5958,-112.0270],
  // Nebraska
  "omaha,ne":[41.2565,-95.9345],"lincoln,ne":[40.8136,-96.7026],"bellevue,ne":[41.1539,-95.9146],
  "grand island,ne":[40.9264,-98.3420],"kearney,ne":[40.6993,-99.0817],
  // Nevada
  "las vegas,nv":[36.1699,-115.1398],"henderson,nv":[36.0395,-114.9817],"reno,nv":[39.5296,-119.8138],
  "north las vegas,nv":[36.1989,-115.1175],"sparks,nv":[39.5349,-119.7527],"carson city,nv":[39.1638,-119.7674],
  // New Hampshire
  "manchester,nh":[42.9956,-71.4548],"nashua,nh":[42.7654,-71.4676],"concord,nh":[43.2081,-71.5376],
  // New Jersey
  "newark,nj":[40.7357,-74.1724],"jersey city,nj":[40.7178,-74.0431],"paterson,nj":[40.9168,-74.1718],
  "elizabeth,nj":[40.6640,-74.2107],"trenton,nj":[40.2171,-74.7429],"clifton,nj":[40.8584,-74.1638],
  "camden,nj":[39.9259,-75.1196],"passaic,nj":[40.8568,-74.1285],"union city,nj":[40.7968,-74.0318],
  "cherry hill,nj":[39.9348,-75.0349],
  // New Mexico
  "albuquerque,nm":[35.0844,-106.6504],"las cruces,nm":[32.3199,-106.7637],"rio rancho,nm":[35.2328,-106.6630],
  "santa fe,nm":[35.6870,-105.9378],"roswell,nm":[33.3943,-104.5230],
  // New York
  "new york,ny":[40.7128,-74.0060],"buffalo,ny":[42.8864,-78.8784],"rochester,ny":[43.1566,-77.6088],
  "yonkers,ny":[40.9312,-73.8988],"syracuse,ny":[43.0481,-76.1474],"albany,ny":[42.6526,-73.7562],
  "new rochelle,ny":[40.9115,-73.7826],"mount vernon,ny":[40.9126,-73.8371],"schenectady,ny":[42.8142,-73.9396],
  "utica,ny":[43.1009,-75.2327],"white plains,ny":[41.0340,-73.7629],
  // North Carolina
  "charlotte,nc":[35.2271,-80.8431],"raleigh,nc":[35.7796,-78.6382],"greensboro,nc":[36.0726,-79.7920],
  "durham,nc":[35.9940,-78.8986],"winston-salem,nc":[36.0999,-80.2442],"fayetteville,nc":[35.0527,-78.8784],
  "cary,nc":[35.7915,-78.7811],"wilmington,nc":[34.2257,-77.9447],"high point,nc":[35.9557,-80.0053],
  "concord,nc":[35.4088,-80.5795],"gastonia,nc":[35.2621,-81.1873],"asheville,nc":[35.5951,-82.5515],
  "jacksonville,nc":[34.7541,-77.4302],
  // North Dakota
  "fargo,nd":[46.8772,-96.7898],"bismarck,nd":[46.8083,-100.7837],"grand forks,nd":[47.9253,-97.0329],
  "minot,nd":[48.2325,-101.2963],
  // Ohio
  "columbus,oh":[39.9612,-82.9988],"cleveland,oh":[41.4993,-81.6944],"cincinnati,oh":[39.1031,-84.5120],
  "toledo,oh":[41.6528,-83.5379],"akron,oh":[41.0814,-81.5190],"dayton,oh":[39.7589,-84.1916],
  "parma,oh":[41.3845,-81.7229],"canton,oh":[40.7989,-81.3784],"youngstown,oh":[41.0998,-80.6495],
  "lorain,oh":[41.4528,-82.1824],"hamilton,oh":[39.3995,-84.5613],"springfield,oh":[39.9242,-83.8088],
  "kettering,oh":[39.6895,-84.1688],"elyria,oh":[41.3681,-82.1077],
  // Oklahoma
  "oklahoma city,ok":[35.4676,-97.5164],"tulsa,ok":[36.1540,-95.9928],"norman,ok":[35.2226,-97.4395],
  "broken arrow,ok":[36.0526,-95.7908],"lawton,ok":[34.6036,-98.3959],"edmond,ok":[35.6528,-97.4781],
  // Oregon
  "portland,or":[45.5051,-122.6750],"eugene,or":[44.0521,-123.0868],"salem,or":[44.9429,-123.0351],
  "gresham,or":[45.5001,-122.4302],"hillsboro,or":[45.5229,-122.9898],"beaverton,or":[45.4871,-122.8037],
  "bend,or":[44.0582,-121.3153],"medford,or":[42.3265,-122.8756],"springfield,or":[44.0462,-123.0220],
  // Pennsylvania
  "philadelphia,pa":[39.9526,-75.1652],"pittsburgh,pa":[40.4406,-79.9959],"allentown,pa":[40.6023,-75.4714],
  "erie,pa":[42.1292,-80.0851],"reading,pa":[40.3356,-75.9269],"scranton,pa":[41.4090,-75.6624],
  "bethlehem,pa":[40.6259,-75.3705],"lancaster,pa":[40.0379,-76.3055],"harrisburg,pa":[40.2732,-76.8867],
  "altoona,pa":[40.5187,-78.3947],"york,pa":[39.9626,-76.7277],"wilkes-barre,pa":[41.2459,-75.8813],
  // Rhode Island
  "providence,ri":[41.8240,-71.4128],"cranston,ri":[41.7798,-71.4373],"pawtucket,ri":[41.8787,-71.3826],
  // South Carolina
  "columbia,sc":[34.0007,-81.0348],"charleston,sc":[32.7765,-79.9311],"north charleston,sc":[32.8546,-79.9748],
  "greenville,sc":[34.8526,-82.3940],"rock hill,sc":[34.9249,-81.0251],"spartanburg,sc":[34.9496,-81.9320],
  // South Dakota
  "sioux falls,sd":[43.5446,-96.7311],"rapid city,sd":[44.0805,-103.2310],"pierre,sd":[44.3683,-100.3510],
  // Tennessee
  "nashville,tn":[36.1627,-86.7816],"memphis,tn":[35.1495,-90.0490],"knoxville,tn":[35.9606,-83.9207],
  "chattanooga,tn":[35.0456,-85.3097],"clarksville,tn":[36.5298,-87.3595],"murfreesboro,tn":[35.8456,-86.3903],
  "franklin,tn":[35.9251,-86.8689],"jackson,tn":[35.6145,-88.8139],"johnson city,tn":[36.3134,-82.3535],
  "bartlett,tn":[35.2045,-89.8745],"smyrna,tn":[35.9831,-86.5180],"hendersonville,tn":[36.3048,-86.6200],
  // Texas
  "houston,tx":[29.7604,-95.3698],"san antonio,tx":[29.4241,-98.4936],"dallas,tx":[32.7767,-96.7970],
  "austin,tx":[30.2672,-97.7431],"fort worth,tx":[32.7555,-97.3308],"el paso,tx":[31.7619,-106.4850],
  "arlington,tx":[32.7357,-97.1081],"corpus christi,tx":[27.8006,-97.3964],"plano,tx":[33.0198,-96.6989],
  "laredo,tx":[27.5306,-99.4803],"lubbock,tx":[33.5779,-101.8552],"garland,tx":[32.9126,-96.6389],
  "irving,tx":[32.8140,-96.9489],"amarillo,tx":[35.2220,-101.8313],"grand prairie,tx":[32.7460,-96.9978],
  "mckinney,tx":[33.1972,-96.6397],"frisco,tx":[33.1507,-96.8236],"brownsville,tx":[25.9017,-97.4975],
  "mcallen,tx":[26.2034,-98.2300],"killeen,tx":[31.1171,-97.7278],"waco,tx":[31.5493,-97.1467],
  "denton,tx":[33.2148,-97.1331],"odessa,tx":[31.8457,-102.3676],"midland,tx":[31.9974,-102.0779],
  "pasadena,tx":[29.6911,-95.2091],"mesquite,tx":[32.7668,-96.5992],"carrollton,tx":[32.9537,-96.8903],
  "beaumont,tx":[30.0802,-94.1266],"abilene,tx":[32.4487,-99.7331],"wichita falls,tx":[33.9137,-98.4934],
  "lewisville,tx":[33.0462,-97.0641],"tyler,tx":[32.3513,-95.3011],"allen,tx":[33.1037,-96.6706],
  "pearland,tx":[29.5633,-95.2861],"sugar land,tx":[29.6197,-95.6349],"round rock,tx":[30.5083,-97.6789],
  "richardson,tx":[32.9483,-96.7298],"new braunfels,tx":[29.7030,-98.1245],"longview,tx":[32.5007,-94.7405],
  "port arthur,tx":[29.8849,-93.9399],"wichita falls,tx":[33.9137,-98.4934],"cedar park,tx":[30.5052,-97.8203],
  "temple,tx":[31.0982,-97.3428],"missouri city,tx":[29.6186,-95.5374],"harlingen,tx":[26.1906,-97.6961],
  // Utah
  "salt lake city,ut":[40.7608,-111.8910],"west valley city,ut":[40.6916,-112.0010],"provo,ut":[40.2338,-111.6585],
  "west jordan,ut":[40.6097,-111.9391],"orem,ut":[40.2969,-111.6946],"sandy,ut":[40.5649,-111.8389],
  "ogden,ut":[41.2230,-111.9738],"st. george,ut":[37.0965,-113.5684],"layton,ut":[41.0602,-111.9711],
  "taylorsville,ut":[40.6677,-111.9388],
  // Vermont
  "burlington,vt":[44.4759,-73.2121],"south burlington,vt":[44.4667,-73.1710],"montpelier,vt":[44.2601,-72.5754],
  // Virginia
  "virginia beach,va":[36.8529,-75.9780],"norfolk,va":[36.8508,-76.2859],"chesapeake,va":[36.7682,-76.2874],
  "richmond,va":[37.5407,-77.4360],"newport news,va":[37.0871,-76.4730],"alexandria,va":[38.8048,-77.0469],
  "hampton,va":[37.0299,-76.3452],"roanoke,va":[37.2710,-79.9414],"portsmouth,va":[36.8354,-76.2983],
  "suffolk,va":[36.7282,-76.5836],"lynchburg,va":[37.4138,-79.1422],"harrisonburg,va":[38.4496,-78.8689],
  // Washington
  "seattle,wa":[47.6062,-122.3321],"spokane,wa":[47.6587,-117.4260],"tacoma,wa":[47.2529,-122.4443],
  "vancouver,wa":[45.6387,-122.6615],"bellevue,wa":[47.6101,-122.2015],"everett,wa":[47.9790,-122.2021],
  "kent,wa":[47.3809,-122.2348],"renton,wa":[47.4799,-122.2171],"spokane valley,wa":[47.6732,-117.2394],
  "federal way,wa":[47.3223,-122.3126],"bellingham,wa":[48.7519,-122.4787],"kirkland,wa":[47.6815,-122.2087],
  "kennewick,wa":[46.2112,-119.1372],"yakima,wa":[46.6021,-120.5059],"olympia,wa":[47.0379,-122.9007],
  "redmond,wa":[47.6740,-122.1215],"marysville,wa":[48.0518,-122.1771],
  // West Virginia
  "charleston,wv":[38.3498,-81.6326],"huntington,wv":[38.4192,-82.4452],"parkersburg,wv":[39.2667,-81.5615],
  "morgantown,wv":[39.6295,-79.9559],
  // Wisconsin
  "milwaukee,wi":[43.0389,-87.9065],"madison,wi":[43.0731,-89.4012],"green bay,wi":[44.5133,-88.0133],
  "kenosha,wi":[42.5847,-87.8212],"racine,wi":[42.7261,-87.7829],"appleton,wi":[44.2619,-88.4154],
  "waukesha,wi":[43.0117,-88.2315],"oshkosh,wi":[44.0247,-88.5426],"eau claire,wi":[44.8113,-91.4985],
  "janesville,wi":[42.6828,-89.0187],"west allis,wi":[43.0167,-88.0070],
  // Wyoming
  "cheyenne,wy":[41.1400,-104.8202],"casper,wy":[42.8501,-106.3252],"laramie,wy":[41.3114,-105.5911],
};

// State center fallbacks
const STATE_CENTERS: Record<string, [number, number]> = {
  "AL":[32.7794,-86.8287],"AK":[64.2008,-153.4937],"AZ":[34.2744,-111.6602],"AR":[34.8938,-92.4426],
  "CA":[37.1841,-119.4696],"CO":[38.9972,-105.5478],"CT":[41.6219,-72.7273],"DE":[38.9896,-75.5050],
  "FL":[28.6305,-82.4497],"GA":[32.6415,-83.4426],"HI":[20.2927,-156.3737],"ID":[44.3509,-114.6130],
  "IL":[40.0417,-89.1965],"IN":[39.8942,-86.2816],"IA":[42.0751,-93.4960],"KS":[38.4937,-98.3804],
  "KY":[37.5347,-85.3021],"LA":[31.0689,-91.9968],"ME":[44.6074,-69.3977],"MD":[39.0550,-76.7909],
  "MA":[42.2596,-71.8083],"MI":[44.3467,-85.4102],"MN":[46.2807,-94.3053],"MS":[32.7364,-89.6678],
  "MO":[38.3566,-92.4580],"MT":[46.8797,-110.3626],"NE":[41.5378,-99.7951],"NV":[39.3289,-116.6312],
  "NH":[43.6805,-71.5811],"NJ":[40.1907,-74.6728],"NM":[34.4071,-106.1126],"NY":[42.9538,-75.5268],
  "NC":[35.5557,-79.3877],"ND":[47.4501,-100.4659],"OH":[40.2862,-82.7937],"OK":[35.5376,-96.9247],
  "OR":[43.9336,-120.5583],"PA":[40.8781,-77.7996],"RI":[41.6762,-71.5562],"SC":[33.9169,-80.8964],
  "SD":[44.2998,-99.4388],"TN":[35.7478,-86.6923],"TX":[31.4757,-99.3312],"UT":[39.3210,-111.0937],
  "VT":[44.0687,-72.6658],"VA":[37.5215,-78.8537],"WA":[47.3826,-120.4472],"WV":[38.6409,-80.6227],
  "WI":[44.2563,-89.6385],"WY":[42.9957,-107.5512],"DC":[38.9072,-77.0369],
};

export function geocodeCity(city: string, state: string): [number, number] | null {
  const cityClean = city.toLowerCase().trim()
    .replace(/\bst\b\.?\s/g, "st. ")
    .replace(/\bft\b\.?\s/g, "fort ")
    .replace(/\s+/g, " ")
    .trim();
  const stateClean = state.toUpperCase().trim();
  const key = `${cityClean},${stateClean.toLowerCase()}`;
  if (CITIES[key]) return CITIES[key];
  // Try without punctuation variants
  const key2 = key.replace(/['.]/g, "").replace(/\s+/g, " ");
  for (const [k, v] of Object.entries(CITIES)) {
    const k2 = k.replace(/['.]/g, "").replace(/\s+/g, " ");
    if (k2 === key2) return v;
  }
  // State fallback
  if (STATE_CENTERS[stateClean]) return STATE_CENTERS[stateClean];
  return null;
}

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
