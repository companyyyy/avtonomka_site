-- Автономка: нова стаття "Перевантаження електромережі: чому вибиває автомат і як цього уникнути".
-- Виконати ОДИН РАЗ у Supabase Dashboard -> SQL Editor -> New query -> Run.
insert into public.articles (id, category, title, summary, body, photo, date, title_en, summary_en, body_en)
values (
  'perevantazhennya-elektromerezhi',
  'komplekty',
  'Перевантаження електромережі: чому вибиває автомат і як цього уникнути',
  'Чому вибиває автомат, скільки кВт витримує розетка і квартира, які прилади не вмикати разом і як не перевантажити інвертор під час відключень.',
  'Працює пральна машина, бойлер гріє воду, на кухні ввімкнена духовка, і варто натиснути кнопку електрочайника, як у квартирі зникає світло. Найчастіше причина в перевантаженні електромережі: сумарна потужність увімкнених приладів перевищує допустиму, і спрацьовує захисний автомат.

У цій статті розберемо, чому вибиває автомат, скільки кВт витримує розетка, автомат і квартира, які прилади не варто вмикати одночасно та як правильно розподіляти навантаження, зокрема під час відключень світла, коли техніка працює від інвертора й акумулятора.

## Чому вибиває автомат: перевантаження електромережі

Автоматичний вимикач захищає проводку від перегріву. Кожен автомат розрахований на певний струм, наприклад 16 А або 25 А. Коли увімкнені прилади разом споживають більше, автомат розмикає коло, щоб кабель не перегрівся і не виникла пожежа.

Найчастіші причини, чому вибиває автомат:

- **Перевантаження.** Одночасно працюють кілька потужних приладів, і сумарний струм перевищує номінал автомата.
- **Пускові струми.** Холодильник, насос, кондиціонер чи пральна машина в момент запуску на кілька секунд споживають у кілька разів більше, ніж у звичайному режимі.
- **Коротке замикання або несправний прилад.** Автомат спрацьовує миттєво, навіть якщо ввімкнено лише один пристрій.
- **Старий або слабкий автомат.** З часом захисні пристрої зношуються і можуть спрацьовувати раніше.

Якщо автомат вибиває саме тоді, коли ви вмикаєте ще один потужний прилад, майже напевно причина в перевантаженні. Якщо ж він спрацьовує без видимої причини або регулярно, варто викликати електрика.

## Скільки кВт витримує розетка, автомат і квартира

Щоб розуміти, чи загрожує вашій мережі перевантаження, потрібно знати її межі. Допустиму потужність легко порахувати за формулою: **потужність (Вт) = струм (А) × напруга (В)**. Для побутової мережі 230 В орієнтовні значення такі:

| Елемент мережі | Номінальний струм | Орієнтовна потужність |
|---|---|---|
| Звичайна розетка | 10–16 А | 2,3–3,7 кВт |
| Подовжувач (більшість моделей) | 10 А | до 2,2 кВт |
| Автомат 16 А | 16 А | близько 3,7 кВт |
| Автомат 25 А | 25 А | близько 5,7 кВт |
| Автомат 32 А | 32 А | близько 7,4 кВт |

На практиці краще не навантажувати лінію більш ніж на 80% від номіналу, особливо якщо техніка працює довго.

Виділена потужність квартири залежить від будинку і договору з постачальником. У старих будинках це часто 3–5 кВт, у новобудовах 7–10 кВт і більше. Точне значення вказане в договорі або на вступному автоматі в щитку.

**Важливо:** розетки в квартирі зазвичай об''єднані в кілька ліній, кожна зі своїм автоматом. Тому чайник і обігрівач на одній кухонній лінії можуть вибити автомат навіть тоді, коли загальна потужність квартири ще не вичерпана.

## Потужність побутових приладів: таблиця

Найбільше енергії споживають прилади з нагрівальними елементами. Точну потужність вашої техніки шукайте на корпусі або в інструкції, а для орієнтиру скористайтеся таблицею:

| Прилад | Типова потужність | Примітка |
|---|---|---|
| Варильна поверхня (електрична, індукційна) | 3000–7000 Вт | Залежить від кількості ввімкнених конфорок |
| Електродуховка | 2000–3500 Вт | Максимум під час розігріву |
| Електрочайник | 1800–2400 Вт | Працює недовго, але дає різкий пік |
| Пральна машина | 2000–2500 Вт | Пік під час нагріву води |
| Посудомийна машина | 1800–2400 Вт | Пік під час нагріву води |
| Бойлер | 1500–2500 Вт | Вмикається автоматично для підтримання температури |
| Обігрівач | 1000–2500 Вт | Довго працює на повній потужності |
| Праска | 1500–2400 Вт | Нагрівальний елемент вмикається циклічно |
| Кондиціонер | 700–2500 Вт | Високий пусковий струм |
| Фен | 1000–2200 Вт | — |
| Пилосос | 700–2000 Вт | — |
| Мікрохвильова піч | 1000–1500 Вт | Споживає більше, ніж вказана потужність НВЧ |
| Холодильник | 100–300 Вт | Пуск до 1000 Вт і більше |
| Телевізор | 50–200 Вт | — |
| Ноутбук | 45–100 Вт | — |
| Роутер | 5–15 Вт | — |
| LED-лампа | 5–15 Вт | — |

Достатньо скласти потужність приладів, які ви вмикаєте разом, і порівняти суму з можливостями автомата чи інвертора. Наприклад, електрочайник на 2200 Вт і обігрівач на 2000 Вт разом дають 4200 Вт. Це вже більше, ніж витримує лінія з автоматом 16 А.

## Які прилади не можна вмикати одночасно

Суворої заборони немає, але деякі поєднання майже гарантовано перевантажують одну лінію або всю квартиру зі старою проводкою. Особливо обережно варто бути з такими парами:

- **Духовка + електрочайник + обігрівач.** Разом це 6 кВт і більше, тобто більше, ніж виділено багатьом квартирам.
- **Пральна машина + бойлер.** Обидва прилади гріють воду, і їхні піки легко збігаються.
- **Варильна поверхня + духовка + посудомийна машина.** Типова кухонна ситуація, за якої вибиває автомат кухонної лінії.
- **Обігрівач + праска або фен в одній розетці.** Особливо через подовжувач, розрахований на 10 А.
- **Кондиціонер + інша потужна техніка.** Пусковий струм кондиціонера додається до вже наявного навантаження.

Пам''ятайте, що бойлер, холодильник і пральна машина вмикають нагрів або компресор самостійно. Тому навантаження може зрости тоді, коли ви нічого нового не вмикали.

## Навантаження на інвертор під час відключень світла

Під час відключень електроенергії можливості мережі обмежує вже не автомат, а потужність інвертора та ємність акумулятора. Тут правило «не вмикати все одразу» стає ще важливішим.

**Потужність інвертора.** Наприклад, [гібридний інвертор MUST PV19-6048EXP](https://avtonomka.com.ua/product/must-pv19-6048exp/150935.html) має номінальну потужність 6 кВт. Цього достатньо для більшості побутової техніки, але не для всієї одночасно: духовка, електрочайник і обігрівач разом уже виходять за межі 6 кВт. Якщо навантаження перевищить допустиме, інвертор спрацює на захист і вимкне живлення.

**Пускові струми.** Холодильник, насос, кондиціонер та інша техніка з електродвигуном під час запуску можуть споживати в 3–5 разів більше за номінал. Холодильник на 150 Вт у момент старту може «просити» 600–800 Вт. Цей запас потрібно враховувати, підбираючи інвертор.

**Заряд акумулятора.** Що потужніший прилад, то швидше він розряджає батарею. Для прикладу візьмемо акумулятор ємністю 5 кВт·год:

| Прилад | Час роботи | Витрата енергії | Частка акумулятора 5 кВт·год |
|---|---|---|---|
| Обігрівач 2000 Вт | 1 год | 2 кВт·год | близько 40% |
| Електрочайник 2200 Вт | 3 хв | 0,11 кВт·год | близько 2% |
| Холодильник (в середньому) | 24 год | 1–1,5 кВт·год | 20–30% |
| Роутер 10 Вт | 24 год | 0,24 кВт·год | близько 5% |
| 5 LED-ламп по 10 Вт | 5 год | 0,25 кВт·год | близько 5% |

Одна година роботи обігрівача забирає стільки ж енергії, скільки роутер споживає майже за тиждень. Тому перш ніж обирати [комплект автономного живлення](https://avtonomka.com.ua/catalog/komplekty.html), складіть список приладів, які мають працювати під час відключень, їхню потужність і бажаний час роботи.

## Як перевірити, скільки споживає техніка

Потужність на корпусі приладу показує максимальне значення, а реальне споживання часто інше. Перевірити його можна двома способами.

**Розетковий енергометр.** Найпростіший варіант для дому. Енергометр вмикається у звичайну розетку, а прилад підключається до нього. На екрані видно поточну потужність, напругу і спожиту енергію за період. Так легко з''ясувати, скільки насправді споживає холодильник, телевізор, комп''ютер чи бойлер.

**Струмовимірювальні кліщі.** Інструмент для тих, хто має досвід роботи з електрикою, або для електрика. Наприклад, кліщі UNI-T UT202A+ вимірюють силу струму без розриву кола, тож можна оцінити навантаження на окрему лінію в щитку. Самостійно працювати в електрощитку без кваліфікації не варто.

## Як уникнути перевантаження електромережі: 6 правил

- **Вмикайте потужні прилади по черзі.** Поки працює духовка, зачекайте з чайником чи праскою.
- **Не підключайте потужну техніку через подовжувач.** Обігрівач, бойлер чи пральну машину вмикайте у стаціонарну розетку.
- **Враховуйте техніку, що вмикається сама.** Бойлер і холодильник можуть додати навантаження без вашої участі.
- **Знайте номінал своїх автоматів.** Підпишіть у щитку, яка лінія за що відповідає, і порахуйте її межу.
- **Не ігноруйте регулярне спрацювання автомата.** Не міняйте його на потужніший самостійно: це небезпечно для проводки. Зверніться до електрика.
- **Економте заряд під час відключень.** Від інвертора живіть насамперед холодильник, освітлення, роутер і зв''язок, а чайник і обігрівач вмикайте лише за потреби.

Дотримання цих простих правил дозволяє користуватися звичною технікою без вибитих автоматів, а під час відключень довше зберігати заряд для справді необхідних приладів.

## Часті запитання

**Скільки кВт витримує звичайна розетка?** Більшість побутових розеток розраховані на 10–16 А, тобто на 2,3–3,7 кВт. Фактична межа залежить також від перерізу кабелю та номіналу автомата лінії.

**Скільки кВт витримує автомат 16 А?** При напрузі 230 В близько 3,7 кВт. Для тривалого навантаження краще не перевищувати 80% від цього значення, тобто приблизно 3 кВт.

**Чому вибиває автомат, коли вмикаю чайник?** Найчастіше лінія вже навантажена іншою технікою, а чайник на 2 кВт перевищує її межу. Якщо автомат вибиває, навіть коли чайник увімкнено один, можлива несправність приладу або проводки.

**Чи можна одночасно вмикати бойлер і пральну машину?** Можна, якщо вони на різних лініях або сумарна потужність не перевищує номінал автомата. Обидва прилади гріють воду, тому разом можуть споживати 4–5 кВт.

**Що буде, якщо перевантажити інвертор?** Інвертор спрацює на захист і тимчасово вимкне живлення. Щоб цього не сталося, сумарна потужність техніки разом із пусковими струмами має бути меншою за номінальну потужність інвертора.

**Що можна підключити до інвертора на 6 кВт?** Холодильник, освітлення, роутер, телевізор, комп''ютер, насос, пральну машину, а також чайник чи мікрохвильовку по черзі. Одночасно вмикати кілька нагрівальних приладів не варто.',
  'assets/images/articles/perevantazhennya-elektromerezhi.jpg',
  '2026-10-28',
  'Circuit Overload: Why the Breaker Trips and How to Avoid It',
  'Why the breaker trips, how many kW a socket and a flat can handle, which appliances not to run together and how not to overload an inverter during outages.',
  'The washing machine is running, the water heater is heating, the oven is on in the kitchen, and the moment you switch on the electric kettle, the power in the flat goes out. Most often the cause is an overloaded circuit: the combined power of the appliances that are on exceeds the permitted limit, and the circuit breaker trips.

In this article we explain why the breaker trips, how many kW a socket, a breaker and a flat can handle, which appliances should not be switched on at the same time and how to spread the load correctly, including during power outages, when your appliances run on an inverter and a battery.

## Why the breaker trips: an overloaded circuit

A circuit breaker protects the wiring from overheating. Every breaker is rated for a certain current, for example 16 A or 25 A. When the appliances that are on draw more than that together, the breaker opens the circuit so that the cable does not overheat and cause a fire.

The most common reasons a breaker trips:

- **Overload.** Several powerful appliances run at once, and the total current exceeds the breaker''s rating.
- **Inrush current.** At start-up, a fridge, pump, air conditioner or washing machine draws several times more than in normal operation for a few seconds.
- **Short circuit or a faulty appliance.** The breaker trips instantly, even if only one device is on.
- **An old or weak breaker.** Protective devices wear out over time and may start tripping earlier.

If the breaker trips exactly when you switch on one more powerful appliance, the cause is almost certainly overload. If it trips for no obvious reason or regularly, call an electrician.

## How many kW a socket, a breaker and a flat can handle

To know whether your circuit is at risk of overload, you need to know its limits. The permitted power is easy to calculate: **power (W) = current (A) × voltage (V)**. For a 230 V household supply, the approximate values are:

| Part of the circuit | Rated current | Approximate power |
|---|---|---|
| Standard socket | 10–16 A | 2.3–3.7 kW |
| Extension lead (most models) | 10 A | up to 2.2 kW |
| 16 A breaker | 16 A | about 3.7 kW |
| 25 A breaker | 25 A | about 5.7 kW |
| 32 A breaker | 32 A | about 7.4 kW |

In practice it is better not to load a line above 80% of its rating, especially if appliances run for a long time.

The power allocated to a flat depends on the building and the contract with the supplier. In older buildings it is often 3–5 kW, in new builds 7–10 kW or more. The exact value is stated in the contract or on the main breaker in the distribution board.

**Important:** the sockets in a flat are usually split into several lines, each with its own breaker. So a kettle and a heater on the same kitchen line can trip the breaker even when the flat''s total power limit has not been reached.

## Power of household appliances: table

Appliances with heating elements use the most energy. Look for the exact power of your appliances on the casing or in the manual, and use this table as a guide:

| Appliance | Typical power | Note |
|---|---|---|
| Hob (electric, induction) | 3000–7000 W | Depends on how many zones are on |
| Electric oven | 2000–3500 W | Maximum while heating up |
| Electric kettle | 1800–2400 W | Runs briefly but gives a sharp peak |
| Washing machine | 2000–2500 W | Peak while heating water |
| Dishwasher | 1800–2400 W | Peak while heating water |
| Water heater | 1500–2500 W | Switches on automatically to keep the temperature |
| Heater | 1000–2500 W | Runs at full power for a long time |
| Iron | 1500–2400 W | The heating element cycles on and off |
| Air conditioner | 700–2500 W | High inrush current |
| Hair dryer | 1000–2200 W | — |
| Vacuum cleaner | 700–2000 W | — |
| Microwave oven | 1000–1500 W | Draws more than its stated microwave power |
| Fridge | 100–300 W | Start-up up to 1000 W or more |
| TV | 50–200 W | — |
| Laptop | 45–100 W | — |
| Router | 5–15 W | — |
| LED bulb | 5–15 W | — |

Simply add up the power of the appliances you use together and compare the total with what the breaker or inverter can handle. For example, a 2200 W kettle and a 2000 W heater together make 4200 W. That is already more than a line with a 16 A breaker can take.

## Which appliances should not be switched on at the same time

There is no strict ban, but some combinations are almost guaranteed to overload a single line, or a whole flat with old wiring. Be especially careful with these:

- **Oven + electric kettle + heater.** Together that is 6 kW or more, more than many flats are allocated.
- **Washing machine + water heater.** Both heat water, and their peaks easily coincide.
- **Hob + oven + dishwasher.** A typical kitchen situation that trips the kitchen line''s breaker.
- **Heater + iron or hair dryer in one socket.** Especially through an extension lead rated for 10 A.
- **Air conditioner + other powerful appliances.** The air conditioner''s inrush current adds to the load that is already there.

Remember that the water heater, fridge and washing machine switch on their heating or compressor by themselves. So the load can rise even when you have not switched anything new on.

## Inverter load during power outages

During a power outage, the limit is no longer the breaker but the inverter''s power and the battery''s capacity. Here the rule "don''t switch everything on at once" becomes even more important.

**Inverter power.** For example, the [MUST PV19-6048EXP hybrid inverter](https://avtonomka.com.ua/product/must-pv19-6048exp/150935.html) has a rated power of 6 kW. That is enough for most household appliances, but not for all of them at once: an oven, an electric kettle and a heater together already exceed 6 kW. If the load goes above the permitted level, the inverter''s protection trips and it cuts the power.

**Inrush current.** A fridge, pump, air conditioner and other appliances with an electric motor can draw 3–5 times their rated power at start-up. A 150 W fridge may "ask for" 600–800 W at the moment it starts. Allow for this margin when choosing an inverter.

**Battery charge.** The more powerful the appliance, the faster it drains the battery. As an example, take a 5 kWh battery:

| Appliance | Running time | Energy used | Share of a 5 kWh battery |
|---|---|---|---|
| 2000 W heater | 1 h | 2 kWh | about 40% |
| 2200 W electric kettle | 3 min | 0.11 kWh | about 2% |
| Fridge (on average) | 24 h | 1–1.5 kWh | 20–30% |
| 10 W router | 24 h | 0.24 kWh | about 5% |
| 5 LED bulbs, 10 W each | 5 h | 0.25 kWh | about 5% |

One hour of a heater uses as much energy as a router uses in almost a week. So before choosing a [backup power kit](https://avtonomka.com.ua/catalog/komplekty.html), make a list of the appliances that must run during outages, their power and how long you need them to run.

## How to check how much an appliance uses

The power on an appliance''s casing shows the maximum, and actual consumption is often different. There are two ways to check it.

**Plug-in energy meter.** The simplest option for the home. The meter plugs into an ordinary socket, and the appliance plugs into it. The display shows the current power, voltage and the energy used over a period. This makes it easy to find out how much a fridge, TV, computer or water heater really uses.

**Clamp meter.** A tool for people with electrical experience, or for an electrician. For example, the UNI-T UT202A+ clamp meter measures current without breaking the circuit, so you can estimate the load on a single line in the distribution board. Do not work in the distribution board yourself without qualifications.

## How to avoid overloading the circuit: 6 rules

- **Switch on powerful appliances one at a time.** While the oven is on, wait with the kettle or the iron.
- **Don''t plug powerful appliances into an extension lead.** Plug a heater, water heater or washing machine into a fixed wall socket.
- **Allow for appliances that switch on by themselves.** The water heater and fridge can add load without you doing anything.
- **Know the ratings of your breakers.** Label in the distribution board which line powers what, and work out its limit.
- **Don''t ignore a breaker that trips regularly.** Don''t replace it with a higher-rated one yourself: that is dangerous for the wiring. Call an electrician.
- **Save charge during outages.** Use the inverter first of all for the fridge, lighting, router and communications, and switch on the kettle and heater only when needed.

Following these simple rules lets you use your usual appliances without tripped breakers, and during outages keeps the charge longer for the appliances you really need.

## Frequently asked questions

**How many kW can a standard socket handle?** Most household sockets are rated for 10–16 A, i.e. 2.3–3.7 kW. The actual limit also depends on the cable cross-section and the rating of the line''s breaker.

**How many kW can a 16 A breaker handle?** At 230 V, about 3.7 kW. For a continuous load it is better not to exceed 80% of that, i.e. about 3 kW.

**Why does the breaker trip when I switch on the kettle?** Most often the line is already loaded with other appliances, and a 2 kW kettle pushes it over its limit. If the breaker trips even when the kettle is on by itself, the appliance or the wiring may be faulty.

**Can I run the water heater and the washing machine at the same time?** Yes, if they are on different lines or their combined power does not exceed the breaker''s rating. Both heat water, so together they can draw 4–5 kW.

**What happens if the inverter is overloaded?** The inverter''s protection trips and it temporarily cuts the power. To avoid this, the total power of the appliances, including inrush currents, must be lower than the inverter''s rated power.

**What can I connect to a 6 kW inverter?** A fridge, lighting, router, TV, computer, pump and washing machine, plus a kettle or microwave one at a time. Don''t run several heating appliances at once.'
)
on conflict (id) do update set
  category = excluded.category,
  title    = excluded.title,
  summary  = excluded.summary,
  body     = excluded.body,
  photo    = excluded.photo,
  date     = excluded.date,
  title_en   = excluded.title_en,
  summary_en = excluded.summary_en,
  body_en    = excluded.body_en,
  updated_at = now();
