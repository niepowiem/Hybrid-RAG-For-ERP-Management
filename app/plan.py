"""
plan.py -- kroki procedur jako osobne węzły grafu + budowanie planu przez trawersję.

Model danych:

    (Procedura)-[:MA_KROK {kolejnosc}]->(Krok)
    (Procedura)-[:WYMAGA]->(Procedura)      # warunek wstępny

Plan dla procedury P = kroki wszystkich procedur, których P WYMAGA (najgłębsze
najpierw), a na końcu kroki samego P. Dzięki temu dodanie relacji WYMAGA między
dwiema procedurami automatycznie rozszerza plan -- bez zmiany kodu i bez udziału LLM.

NIEZMIENNIK: treść kroku nigdy nie pochodzi od modelu. Węzły Krok tworzy
'attach_steps_from_documents' bezpośrednio z zwalidowanych obiektów Procedure,
już PO tym, jak LLM zbuduje warstwę procedur i relacji.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from neo4j import Driver

from app.graph import KnowledgeGraph
from app.schema import Procedure

STEP_CLASS: str = "Krok"
STATE_CLASS: str = "Stan"

STEP_RELATION: str = "MA_KROK"
REQUIRES_RELATION: str = "WYMAGA"
REQUIRES_STATE_RELATION: str = "WYMAGA_STANU"
PROVIDES_STATE_RELATION: str = "DAJE_STAN"
GOAL_RELATION: str = "MA_CEL"

# Parametry klasy Krok: nazwa -> wartość domyślna.
# 'akcja' trzymamy jako tekst JSON, bo parametry węzła są płaskie.
STEP_CLASS_PARAMETERS: dict[str, Any] = {
    "tekst": "brak danych",
    "anchor": "",
    "akcja": "",
    "uwaga": "",
    # "tak" = krok warunkowy. Jego warunki wstępne NIE pociągają za sobą innych
    # procedur -- inaczej "wybierz zamówienie, jeśli faktura go dotyczy" kazałoby
    # najpierw utworzyć i wysłać zamówienie zakupu.
    "opcjonalny": "nie",
}

STEP_RELATION_PARAMETERS: dict[str, Any] = {"kolejnosc": 0}

STATE_CLASS_PARAMETERS: dict[str, Any] = {"nazwa": "brak danych"}


def register_system_schema(kg: KnowledgeGraph) -> list[str]:
    """
    Rejestruje klasę Krok i relacje MA_KROK / WYMAGA w świeżym grafie.

    Wywoływane raz, zaraz po utworzeniu grafu -- dzięki temu API może na tych
    nazwach polegać, zamiast liczyć na to, że LLM wymyśli akurat takie same.

    :param kg: graf do uzupełnienia
    :return: komunikaty zwrócone przez narzędzia (do wypisania/logu)
    """

    messages: list[str] = [
        kg.define_class(STEP_CLASS, dict(STEP_CLASS_PARAMETERS), ["tekst"]),
        kg.define_class(STATE_CLASS, dict(STATE_CLASS_PARAMETERS), []),
        kg.define_relation(STEP_RELATION, dict(STEP_RELATION_PARAMETERS)),
        kg.define_relation(REQUIRES_RELATION, {}),
        kg.define_relation(REQUIRES_STATE_RELATION, {}),
        kg.define_relation(PROVIDES_STATE_RELATION, {}),
        kg.define_relation(GOAL_RELATION, {}),
    ]

    return messages


def node_id_from_document_id(document_id: str) -> str:
    """
    Konwencja wiążąca dokument z korpusu z węzłem w grafie:
        'proc.magazyn.przyjecie' -> 'proc_magazyn_przyjecie'
        'ERR-1004'               -> 'ERR_1004'

    Ta sama konwencja jest opisana w prompcie systemowym, więc LLM tworzy
    węzły procedur pod dokładnie takimi nazwami.
    """

    return document_id.replace(".", "_").replace("-", "_")


def step_parameters(step: Any) -> dict[str, Any]:
    """
    Parametry WĘZŁA Krok -- dokładnie te i tylko te, które deklaruje
    STEP_CLASS_PARAMETERS. Stany tu nie wchodzą: w grafie żyją jako relacje
    WYMAGA_STANU i DAJE_STAN, a nie jako właściwości węzła.
    """

    return {
        "tekst": step.text,
        "anchor": step.anchor or "",
        "akcja": json.dumps(step.action, ensure_ascii=False, sort_keys=True) if step.action else "",
        "uwaga": step.note or "",
        "opcjonalny": "tak" if getattr(step, "optional", False) else "nie",
    }


def step_identity(step: Any) -> dict[str, Any]:
    """
    Pełna tożsamość kroku: parametry węzła PLUS stany. Wyłącznie do liczenia hasha.

    Stany muszą wejść do tożsamości -- krok o tym samym tekście, ale innych
    warunkach wstępnych, to inna instrukcja i musi być osobnym węzłem.
    """

    return {
        **step_parameters(step),
        "wymaga": ",".join(sorted(step.requires)),
        "daje": ",".join(sorted(step.provides)),
    }


def state_node_id(state: str) -> str:
    """'dokument.typ-pz' -> 'stan_dokument_typ_pz'"""

    return "stan_" + state.strip().replace(".", "_").replace("-", "_")


def step_node_id(step: Any) -> str:
    """
    Nazwa węzła kroku pochodzi z jego TREŚCI, nie z procedury-właściciela.

    Dzięki temu identyczny krok w kilku procedurach to jeden węzeł z kilkoma
    krawędziami MA_KROK: poprawka tekstu propaguje się wszędzie, a plan łączący
    procedury nie powtarza tych samych instrukcji.

    Uwaga: hash obejmuje CAŁY krok (tekst, anchor, akcja, uwaga). Dwa kroki
    różniące się choćby uwagą to celowo dwa osobne węzły -- to różne instrukcje.
    """

    payload = json.dumps(step_identity(step), ensure_ascii=False, sort_keys=True)

    return f"krok_{hashlib.sha1(payload.encode('utf-8')).hexdigest()[:12]}"


def _udalo_sie(wynik: str) -> bool:
    """
    'OK:' i 'INFO:' to sukces. INFO oznacza operację nieblokującą -- np. krawędź,
    która już istniała, albo parametr uzupełniony wartością domyślną.
    Awarią jest wyłącznie 'BŁĄD:'.
    """

    return wynik.startswith(("OK", "INFO"))


def attach_steps_from_documents(kg: KnowledgeGraph, documents: list[Any],
                                verbose: bool = True) -> dict[str, Any]:
    """
    Tworzy węzły Krok i relacje MA_KROK bezpośrednio z obiektów Procedure.

    Uruchamiać PO 'build_graph_with_ollama', a PRZED 'sync()'. Treść kroków
    przepisywana jest 1:1 z YAML-a -- model nie ma tu nic do powiedzenia.

    :param kg: graf zbudowany przez LLM
    :param documents: lista dokumentów z 'load_knowledge()'
    :param verbose: czy wypisywać pominięte procedury
    :return: raport {'kroki': n, 'procedury': n, 'brakujace': [...]}
    """

    created_steps: int = 0
    created_states: int = 0
    reused_steps: int = 0
    total_links: int = 0
    linked_procedures: int = 0
    missing: list[str] = []

    for document in documents:
        if not isinstance(document, Procedure):
            continue

        procedure_node = node_id_from_document_id(document.id)

        # Węzeł procedury musi już istnieć -- tworzy go LLM. Jeśli nazwał go inaczej
        # niż każe konwencja, nie zgadujemy: raportujemy i zostawiamy bez kroków.
        if procedure_node not in kg.nodes:
            missing.append(document.id)
            continue

        for index, step in enumerate(document.steps, 1):
            node_name = step_node_id(step)

            if node_name in kg.nodes:
                # Krok współdzielony z inną procedurą -- węzeł już istnieje,
                # dokładamy tylko krawędź MA_KROK z własną kolejnością.
                reused_steps += 1

            else:
                # Wyniki SPRAWDZAMY -- 'merge' zwraca tekst błędu, a nie rzuca wyjątku.
                merge_result = kg.merge(node_name, STEP_CLASS, document.module, step_parameters(step))
                if not _udalo_sie(merge_result):
                    raise RuntimeError(f"Nie udało się utworzyć węzła kroku '{node_name}' "
                                       f"({step.text[:40]}...):\n{merge_result}")

                created_steps += 1

            relation_result = kg.relationship(procedure_node, [node_name], STEP_RELATION,
                                              {"kolejnosc": index})
            if not _udalo_sie(relation_result):
                raise RuntimeError(f"Nie udało się połączyć '{procedure_node}' -> '{node_name}':\n{relation_result}")

            total_links += 1

            for state, relation in ((step.requires, REQUIRES_STATE_RELATION),
                                    (step.provides, PROVIDES_STATE_RELATION)):
                for nazwa in state:
                    state_node = state_node_id(nazwa)

                    if state_node not in kg.nodes:
                        state_result = kg.merge(state_node, STATE_CLASS, document.module, {"nazwa": nazwa})
                        if not _udalo_sie(state_result):
                            raise RuntimeError(f"Nie udało się utworzyć stanu '{nazwa}':\n{state_result}")

                        created_states += 1

                    kg.relationship(node_name, [state_node], relation, None)

        for nazwa in getattr(document, "goal", []):
            state_node = state_node_id(nazwa)

            if state_node not in kg.nodes:
                state_result = kg.merge(state_node, STATE_CLASS, document.module, {"nazwa": nazwa})
                if not _udalo_sie(state_result):
                    raise RuntimeError(f"Nie udało się utworzyć stanu celu '{nazwa}':\n{state_result}")

                created_states += 1

            kg.relationship(procedure_node, [state_node], GOAL_RELATION, None)

        linked_procedures += 1

    if verbose and missing:
        print(f"\nUWAGA: {len(missing)} procedur nie ma węzła o oczekiwanej nazwie "
              f"-- ich kroki NIE zostały dodane:")
        for document_id in missing:
            print(f"  {document_id} -> oczekiwano węzła '{node_id_from_document_id(document_id)}'")

    return {"kroki": created_steps, "wspoldzielone": reused_steps, "krawedzie": total_links,
            "stany": created_states, "procedury": linked_procedures, "brakujace": missing}


def build_plan(driver: Driver, node_id: str, max_depth: int = 3,
               database: str = "neo4j") -> list[dict[str, Any]]:
    """
    Składa uporządkowany plan kroków dla węzła procedury, rozwijając warunki
    wstępne (WYMAGA) w głąb.

    Kolejność: procedury najgłębiej w łańcuchu wymagań idą pierwsze, sama
    procedura docelowa ostatnia; wewnątrz procedury kroki wg 'kolejnosc'.

    :param driver: sterownik neo4j
    :param node_id: node_id procedury startowej
    :param max_depth: ile poziomów WYMAGA rozwijać
    :param database: nazwa bazy
    :return: lista {'procedura': str, 'tekst': str, 'anchor': str, 'akcja': str, 'uwaga': str}
    """

    depth = max(0, int(max_depth))

    query = f"""
        MATCH path = (start:{KnowledgeGraph.SHARED_LABEL} {{node_id: $node_id}})
                     -[:{REQUIRES_RELATION}*0..{depth}]->(proc)
        WITH proc, max(length(path)) AS glebokosc
        ORDER BY glebokosc DESC, proc.node_id
        WITH collect(proc) AS procedury
        UNWIND range(0, size(procedury) - 1) AS idx
        WITH procedury[idx] AS proc, idx AS kolejnosc_procedury
        MATCH (proc)-[r:{STEP_RELATION}]->(krok)
        WITH proc, kolejnosc_procedury, krok, coalesce(r.kolejnosc, 0) AS kolejnosc_kroku
        ORDER BY kolejnosc_procedury, kolejnosc_kroku
        RETURN proc.node_id AS procedura,
               krok.node_id AS krok_id,
               krok.tekst   AS tekst,
               krok.anchor  AS anchor,
               krok.akcja   AS akcja,
               krok.uwaga   AS uwaga,
               krok.opcjonalny AS opcjonalny
    """

    records, _, _ = driver.execute_query(query, node_id=node_id, database_=database)

    # Deduplikacja: ten sam węzeł kroku może należeć do kilku procedur w planie
    # (np. "Kliknij Nowy dokument" w procedurze wymaganej i docelowej).
    # Zostawiamy pierwsze wystąpienie -- czyli to najwcześniejsze w kolejności.
    plan: list[dict[str, Any]] = []
    seen: set[str] = set()

    for record in records:
        row = dict(record)

        if row["krok_id"] in seen:
            continue

        seen.add(row["krok_id"])
        plan.append(row)

    return plan


def parse_action(raw: str | None, step_anchor: str | None = None) -> dict[str, Any] | None:
    """
    Zamienia zapisany tekst JSON na obiekt AssistantAction -- ale tylko wtedy,
    gdy pasuje do jednego z czterech wariantów z kontraktu. Cokolwiek innego
    jest odrzucane, żeby front nigdy nie dostał akcji, której nie umie wykonać.

    :param raw: zserializowana akcja z parametru 'akcja' węzła Krok
    :param step_anchor: anchor kroku. Kontrakt wymaga 'anchor' wewnątrz akcji,
        ale w YAML-u nie ma sensu go dublować -- jeśli akcja go nie podaje,
        dziedziczy go z kroku.
    """

    if not raw:
        return None

    try:
        action = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None

    if not isinstance(action, dict):
        return None

    kind = action.get("kind")

    # Dziedziczenie anchora z kroku -- akcja podana jawnie ma pierwszeństwo.
    if not action.get("anchor") and step_anchor:
        action["anchor"] = step_anchor

    required: dict[str, tuple[str, ...]] = {
        "navigate": ("route",),
        "click": ("anchor",),
        "fill": ("anchor", "value"),
        "select": ("anchor", "label"),
    }

    if kind not in required:
        return None

    if any(not isinstance(action.get(key), str) or not action.get(key) for key in required[kind]):
        return None

    return {"kind": kind, **{key: action[key] for key in required[kind]}}


def step_states(driver: Driver, kroki: list[str], database: str = "neo4j") -> dict[str, tuple[set[str], set[str]]]:
    """
    Dla listy node_id kroków zwraca mapę: krok -> (wymagane stany, dawane stany).
    Jedno zapytanie zamiast N -- plany potrafią mieć kilkadziesiąt kroków.
    """

    zapytanie = f"""
        UNWIND $kroki AS kid
        MATCH (k {{node_id: kid}})
        OPTIONAL MATCH (k)-[:{REQUIRES_STATE_RELATION}]->(w)
        OPTIONAL MATCH (k)-[:{PROVIDES_STATE_RELATION}]->(d)
        RETURN kid AS krok,
               collect(DISTINCT w.nazwa) AS wymaga,
               collect(DISTINCT d.nazwa) AS daje
    """

    records, _, _ = driver.execute_query(zapytanie, kroki=kroki, database_=database)

    return {r["krok"]: (set(filter(None, r["wymaga"])), set(filter(None, r["daje"])))
            for r in records}


def validate_plan(driver: Driver, kroki: list[str], stan_poczatkowy: set[str] | None = None,
                  database: str = "neo4j") -> list[str]:
    """
    Symuluje wykonanie planu, utrzymując zbiór spełnionych stanów.

    Zwraca listę problemów -- pustą, jeśli plan jest wykonalny. To jest odpowiedź
    na pytanie "czy ta kolejność kroków jest poprawna": krok żądający stanu,
    którego nikt wcześniej nie wytworzył, to błąd niezależnie od tego, jak
    sensownie brzmi jego tekst.

    :param kroki: node_id kroków w kolejności wykonania
    :param stan_poczatkowy: co użytkownik ma już spełnione (np. z kontekstu UI)
    """

    opis = step_states(driver, kroki, database=database)
    stan = set(stan_poczatkowy or set())
    problemy: list[str] = []

    for i, krok in enumerate(kroki, 1):
        wymaga, daje = opis.get(krok, (set(), set()))

        if brakuje := wymaga - stan:
            problemy.append(f"Krok {i} ({krok}) wymaga niespełnionych stanów: {sorted(brakuje)}")

        stan |= daje

    return problemy


def validate_corpus(driver: Driver, database: str = "neo4j") -> dict[str, list[Any]]:
    """
    Sprawdza spójność całej bazy wiedzy. Każda pozycja w wyniku to problem
    do naprawienia w YAML-u, nie w kodzie.
    """

    zapytania: dict[str, str] = {
        "stany_bez_producenta": f"""
            MATCH (k)-[:{REQUIRES_STATE_RELATION}]->(s)
            WHERE NOT ()-[:{PROVIDES_STATE_RELATION}]->(s)
            RETURN DISTINCT s.nazwa AS problem""",

        "stany_nieuzywane": f"""
            MATCH (s {{klasa: '{STATE_CLASS}'}})
            WHERE NOT ()-[:{REQUIRES_STATE_RELATION}]->(s)
            RETURN s.nazwa AS problem""",

        "kroki_bez_stanow": f"""
            MATCH (k {{klasa: '{STEP_CLASS}'}})
            WHERE NOT (k)-[:{PROVIDES_STATE_RELATION}]->()
            RETURN k.tekst AS problem""",

        "akcja_bez_anchora": f"""
            MATCH (k {{klasa: '{STEP_CLASS}'}})
            WHERE k.akcja <> '' AND k.anchor = ''
            RETURN k.tekst AS problem""",

        "duplikat_kolejnosci": f"""
            MATCH (p)-[r:{STEP_RELATION}]->()
            WITH p, r.kolejnosc AS nr, count(*) AS ile WHERE ile > 1
            RETURN p.node_id + ' kolejnosc=' + toString(nr) AS problem""",

        "cykl_wymagan": f"""
            MATCH (a)-[:{REQUIRES_RELATION}*1..10]->(a)
            RETURN DISTINCT a.node_id AS problem""",
    }

    wynik: dict[str, list[Any]] = {}

    for nazwa, zapytanie in zapytania.items():
        records, _, _ = driver.execute_query(zapytanie, database_=database)
        if records:
            wynik[nazwa] = [r["problem"] for r in records]

    return wynik


# --- Planowanie od celu -------------------------------------------------------

def load_step_index(driver: Driver, database: str = "neo4j") -> dict[str, dict[str, Any]]:
    """
    Wczytuje wszystkie kroki wraz z ich stanami do pamięci -- jednym zapytaniem.

    Planowanie robi setki sprawdzeń "kto daje stan X"; odpytywanie bazy za każdym
    razem byłoby wolniejsze o rzędy wielkości niż wczytanie kilkuset węzłów naraz.
    """

    zapytanie = f"""
        MATCH (k {{klasa: '{STEP_CLASS}'}})
        OPTIONAL MATCH (k)-[:{REQUIRES_STATE_RELATION}]->(w)
        OPTIONAL MATCH (k)-[:{PROVIDES_STATE_RELATION}]->(d)
        RETURN k.node_id AS node_id, k.tekst AS tekst, k.anchor AS anchor,
               k.akcja AS akcja, k.uwaga AS uwaga, k.modul AS modul,
               k.opcjonalny AS opcjonalny,
               collect(DISTINCT w.nazwa) AS wymaga,
               collect(DISTINCT d.nazwa) AS daje
    """

    records, _, _ = driver.execute_query(zapytanie, database_=database)

    index: dict[str, dict[str, Any]] = {}

    for r in records:
        index[r["node_id"]] = {
            "node_id": r["node_id"],
            "tekst": r["tekst"],
            "anchor": r["anchor"],
            "akcja": r["akcja"],
            "uwaga": r["uwaga"],
            "modul": r["modul"],
            "opcjonalny": r["opcjonalny"] == "tak",
            "wymaga": set(filter(None, r["wymaga"])),
            "daje": set(filter(None, r["daje"])),
        }

    return index


def goal_states(driver: Driver, node_id: str, database: str = "neo4j") -> list[str]:
    """Stany, które procedura ma osiągnąć (relacja MA_CEL)."""

    records, _, _ = driver.execute_query(
        f"MATCH (p {{node_id: $node_id}})-[:{GOAL_RELATION}]->(s) RETURN s.nazwa AS nazwa",
        node_id=node_id, database_=database)

    return [r["nazwa"] for r in records]


def estimate_state_costs(index: dict[str, dict[str, Any]],
                         stan_poczatkowy: set[str] | None = None) -> dict[str, int]:
    """
    Dla każdego stanu szacuje minimalną liczbę kroków potrzebnych do jego osiągnięcia
    (zrelaksowany graf planowania: koszt kroku = 1 + koszt najdroższego warunku).

    Bez tego planer traktuje wszystkie warunki jako równie tanie i przy remisie
    wybiera losowo -- np. domykając zwykłe PZ ścieżką "zapisz szkic, potem
    zatwierdź jako kierownik", która jest poprawna, ale należy do innej procedury.
    """

    koszt: dict[str, int] = {s: 0 for s in (stan_poczatkowy or set())}

    zmiana = True
    while zmiana:
        zmiana = False

        for krok in index.values():
            if any(w not in koszt for w in krok["wymaga"]):
                continue

            kandydat = 1 + max((koszt[w] for w in krok["wymaga"]), default=0)

            for nazwa in krok["daje"]:
                if nazwa not in koszt or kandydat < koszt[nazwa]:
                    koszt[nazwa] = kandydat
                    zmiana = True

    return koszt


class BrakKrokuError(RuntimeError):
    """Żaden krok w bazie wiedzy nie wytwarza wymaganego stanu."""


def plan_for_goal(cele: list[str], index: dict[str, dict[str, Any]],
                  stan_poczatkowy: set[str] | None = None,
                  preferowany_modul: str | None = None,
                  limit: int = 60) -> list[dict[str, Any]]:
    """
    Buduje plan wsteczną regresją: dla każdego celu szuka kroku, który go wytwarza,
    a potem rekurencyjnie zaspokaja warunki tego kroku.

    W odróżnieniu od 'build_plan' nie jest przywiązany do jednej procedury --
    jeśli warunek da się spełnić krokiem z innego modułu, plan go użyje. To jest
    ta elastyczność, po którą wprowadzaliśmy stany.

    :param cele: stany do osiągnięcia (koniunkcja -- wszystkie muszą być spełnione)
    :param index: wynik 'load_step_index'
    :param stan_poczatkowy: co użytkownik ma już spełnione (np. z kontekstu UI)
    :param preferowany_modul: przy remisie wybieramy krok z tego modułu
    :param limit: bezpiecznik na długość planu
    :raises BrakKrokuError: gdy w bazie wiedzy nie ma kroku wytwarzającego dany stan
    """

    stan: set[str] = set(stan_poczatkowy or set())
    plan: list[dict[str, Any]] = []
    uzyte: set[str] = set()

    # Odwrócony indeks: stan -> kroki, które go wytwarzają
    # Kroki warunkowe pomijamy jako producentów -- plan nie ma prawa opierać się
    # na czymś, co użytkownik może pominąć.
    producenci: dict[str, list[dict[str, Any]]] = {}
    for krok in index.values():
        if krok.get("opcjonalny"):
            continue

        for nazwa in krok["daje"]:
            producenci.setdefault(nazwa, []).append(krok)

    szacunek = estimate_state_costs(index, stan)

    def koszt(krok: dict[str, Any]) -> tuple[int, int, int, str]:
        # Szacowana liczba kroków do domknięcia warunków; potem ich liczba,
        # preferowany moduł, a na końcu node_id dla determinizmu.
        niespelnione = krok["wymaga"] - stan

        return (sum(szacunek.get(w, 99) for w in niespelnione),
                len(niespelnione),
                0 if krok["modul"] == preferowany_modul else 1,
                krok["node_id"])

    def osiagnij(cel: str, sciezka: frozenset[str]) -> None:
        if cel in stan:
            return

        if cel in sciezka:
            raise BrakKrokuError(f"Cykl w warunkach: stan '{cel}' wymaga sam siebie")

        if len(plan) >= limit:
            raise BrakKrokuError(f"Przekroczono limit {limit} kroków przy celu '{cel}'")

        kandydaci = sorted(producenci.get(cel, []), key=koszt)

        if not kandydaci:
            raise BrakKrokuError(f"Żaden krok nie wytwarza stanu '{cel}' -- luka w bazie wiedzy")

        ostatni_blad: Exception | None = None

        for krok in kandydaci:
            if krok["node_id"] in uzyte:
                continue

            zapamietany_plan = list(plan)
            zapamietany_stan = set(stan)
            zapamietane_uzyte = set(uzyte)

            try:
                for warunek in sorted(krok["wymaga"]):
                    osiagnij(warunek, sciezka | {cel})

                plan.append(krok)
                uzyte.add(krok["node_id"])
                stan.update(krok["daje"])

                return

            except BrakKrokuError as e:
                # Ten kandydat nie wypalił -- cofamy i próbujemy następnego.
                ostatni_blad = e
                plan[:] = zapamietany_plan
                stan.clear(); stan.update(zapamietany_stan)
                uzyte.clear(); uzyte.update(zapamietane_uzyte)

        raise ostatni_blad or BrakKrokuError(f"Nie da się osiągnąć stanu '{cel}'")

    for cel in cele:
        osiagnij(cel, frozenset())

    return plan


def trim_satisfied(plan: list[dict[str, Any]], index: dict[str, dict[str, Any]],
                   stan_poczatkowy: set[str]) -> list[dict[str, Any]]:
    """
    Usuwa z gotowego planu kroki, których efekt użytkownik już osiągnął.

    Tańsza i bezpieczniejsza alternatywa dla pełnego planowania: zachowuje
    kolejność z korpusu, a jedynie skraca początek, gdy użytkownik jest w trakcie.
    Krok zostaje, jeśli wnosi choć jeden nowy stan albo nie deklaruje żadnego.
    """

    stan = set(stan_poczatkowy)
    wynik: list[dict[str, Any]] = []

    for row in plan:
        opis = index.get(row.get("krok_id") or row.get("node_id"), {})
        daje = opis.get("daje", set())

        if daje and daje <= stan:
            continue

        wynik.append(row)
        stan |= daje

    return wynik


def _row_from_index(krok: dict[str, Any], procedura: str) -> dict[str, Any]:
    """Sprowadza wpis z 'load_step_index' do kształtu wiersza zwracanego przez 'build_plan'."""

    return {"procedura": procedura, "krok_id": krok["node_id"], "tekst": krok["tekst"],
            "anchor": krok["anchor"], "akcja": krok["akcja"], "uwaga": krok["uwaga"],
            "opcjonalny": "tak" if krok.get("opcjonalny") else "nie"}


def full_plan(driver: Driver, node_id: str, stan_poczatkowy: set[str] | None = None,
              preferowany_modul: str | None = None,
              index: dict[str, dict[str, Any]] | None = None,
              database: str = "neo4j") -> list[dict[str, Any]]:
    """
    Plan hybrydowy -- to jest funkcja, której powinien używać asystent.

    Łączy trzy rzeczy, z których każda sama w sobie ma wadę:

    1. 'build_plan' daje kroki w kolejności REDAKCYJNEJ, dokładnie takiej jak w YAML-u.
       Nie umie jednak dociągnąć warunków spełnianych w innej procedurze.
    2. 'plan_for_goal' te warunki dociąga, także z innych modułów, ale pomija kroki
       nieistotne dla celu i porządkuje je po swojemu -- gubi redakcję korpusu.
    3. 'trim_satisfied' skraca początek o to, co użytkownik już zrobił.

    Tutaj: warunki wstępne buduje planer (bo tylko on widzi cały graf), a treść
    właściwej procedury zostaje w kolejności z korpusu.
    """

    index = load_step_index(driver, database=database) if index is None else index
    stan = set(stan_poczatkowy or set())

    rows = build_plan(driver, node_id, database=database)

    # Czego brakuje, żeby ta procedura w ogóle mogła się zacząć
    brakujace: set[str] = set()
    symulowany = set(stan)

    for row in rows:
        opis = index.get(row["krok_id"], {})

        # Krok warunkowy nie generuje warunków wstępnych dla całej procedury.
        # Jego 'wymaga' opisuje, kiedy krok MA sens, a nie co trzeba zrobić wcześniej.
        if not opis.get("opcjonalny"):
            brakujace |= opis.get("wymaga", set()) - symulowany

        symulowany |= opis.get("daje", set())

    prefiks: list[dict[str, Any]] = []

    if brakujace:
        try:
            prefiks = [_row_from_index(k, "(warunek wstępny)")
                       for k in plan_for_goal(sorted(brakujace), index, stan_poczatkowy=stan,
                                              preferowany_modul=preferowany_modul)]
        except BrakKrokuError:
            # Luka w bazie wiedzy -- lepiej pokazać samą procedurę niż nic
            prefiks = []

    polaczony: list[dict[str, Any]] = []
    widziane: set[str] = set()

    for row in prefiks + rows:
        if row["krok_id"] in widziane:
            continue

        widziane.add(row["krok_id"])
        polaczony.append(row)

    return trim_satisfied(polaczony, index, stan)


def related_procedures(driver: Driver, node_id: str, database: str = "neo4j") -> list[str]:
    """
    Znajduje procedury powiązane z węzłem dowolną relacją -- używane, gdy trafiony
    węzeł sam nie ma kroków (błąd, pojęcie), ale graf wie, czym go rozwiązać.

    Procedurę rozpoznajemy PO STRUKTURZE (ma krawędzie MA_KROK), a nie po nazwie
    klasy: nazwy klas wymyśla LLM przy ingeście i mogą się różnić między przebiegami.
    """

    zapytanie = f"""
        MATCH (n {{node_id: $node_id}})-[r]-(p)
        WHERE (p)-[:{STEP_RELATION}]->()
        RETURN DISTINCT p.node_id AS node_id, type(r) AS relacja
        LIMIT 5
    """

    records, _, _ = driver.execute_query(zapytanie, node_id=node_id, database_=database)

    return [r["node_id"] for r in records]