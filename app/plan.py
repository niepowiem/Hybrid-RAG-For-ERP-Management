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

import json
from typing import Any

from neo4j import Driver

from app.graph import KnowledgeGraph
from app.schema import Procedure

STEP_CLASS: str = "Krok"
STEP_RELATION: str = "MA_KROK"
REQUIRES_RELATION: str = "WYMAGA"

# Parametry klasy Krok: nazwa -> wartość domyślna.
# 'akcja' trzymamy jako tekst JSON, bo parametry węzła są płaskie.
STEP_CLASS_PARAMETERS: dict[str, Any] = {
    "tekst": "brak danych",
    "anchor": "",
    "akcja": "",
    "uwaga": "",
}

STEP_RELATION_PARAMETERS: dict[str, Any] = {"kolejnosc": 0}


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
        kg.define_relation(STEP_RELATION, dict(STEP_RELATION_PARAMETERS)),
        kg.define_relation(REQUIRES_RELATION, {}),
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


def step_node_id(document_id: str, index: int) -> str:
    return f"{node_id_from_document_id(document_id)}__krok_{index}"


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
            node_name = step_node_id(document.id, index)

            parameters: dict[str, Any] = {
                "tekst": step.text,
                "anchor": step.anchor or "",
                "akcja": json.dumps(step.action, ensure_ascii=False) if step.action else "",
                "uwaga": step.note or "",
            }

            # Wyniki SPRAWDZAMY -- 'merge' i 'relationship' zwracają tekst błędu,
            # a nie rzucają wyjątku. Bez tego nieudany zapis przechodzi bez śladu.
            merge_result = kg.merge(node_name, STEP_CLASS, document.module, parameters)
            if not merge_result.startswith("OK"):
                raise RuntimeError(f"Nie udało się utworzyć węzła kroku '{node_name}':\n{merge_result}")

            relation_result = kg.relationship(procedure_node, [node_name], STEP_RELATION,
                                              {"kolejnosc": index})
            if not relation_result.startswith("OK"):
                raise RuntimeError(f"Nie udało się połączyć '{procedure_node}' -> '{node_name}':\n{relation_result}")

            created_steps += 1

        linked_procedures += 1

    if verbose and missing:
        print(f"\nUWAGA: {len(missing)} procedur nie ma węzła o oczekiwanej nazwie "
              f"-- ich kroki NIE zostały dodane:")
        for document_id in missing:
            print(f"  {document_id} -> oczekiwano węzła '{node_id_from_document_id(document_id)}'")

    return {"kroki": created_steps, "procedury": linked_procedures, "brakujace": missing}


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
               krok.tekst   AS tekst,
               krok.anchor  AS anchor,
               krok.akcja   AS akcja,
               krok.uwaga   AS uwaga
    """

    records, _, _ = driver.execute_query(query, node_id=node_id, database_=database)

    return [dict(record) for record in records]


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