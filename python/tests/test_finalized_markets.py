import base64
import json
from dataclasses import asdict

import httpx
import msgpack
import pytest
import proof_trading_sdk as sdk
from test_block_header import Stream
from test_markets_snapshot import _engine_bytes, CHAIN

H = 9007199254740991
U64 = (1 << 64)-1


def witness(height=H):
    return {"version":1,"nodeId":"ab"*20,"height":str(height),"finalizedBlockTimeMs":"1793008800000","appHash":"cd"*32}


def book(raw=None, depth=20):
    payload=msgpack.packb([[[U64,U64,2**32-1]],[[0,0,0]]] if raw is None else raw)
    data=base64.b64encode(payload).decode()
    return {"market":"3","depth":str(depth),"height":H,"bookMsgpackB64":data,"data":data,"witness":witness()}


def snapshot():
    return {"data":base64.b64encode(_engine_bytes("engine-66d50df7")).decode(),"witness":witness(9007199254740993)}


def test_book_exact_levels_and_numeric_json_height():
    result=sdk.decode_finalized_orderbook(book(),3)
    assert result.bids == [sdk.FinalizedOrderbookLevel(U64,U64,2**32-1)]
    assert result.asks == [sdk.FinalizedOrderbookLevel(0,0,0)]
    assert (result.market,result.depth,result.height,result.witness.height) == (3,20,H,H)
    value=book(); value.update(height=20.0,witness=witness(20))
    assert type(sdk.decode_finalized_orderbook(value,3).height) is int


@pytest.mark.parametrize("market,depth", [(0,20),(True,20),(2**32,20),(3,0),(3,True),(3,2),(3,101)])
def test_bad_book_selection(market,depth):
    with pytest.raises(sdk.GatewayReadError): sdk.decode_finalized_orderbook(book(),market,depth)


@pytest.mark.parametrize("field,value,kind", [("market","4","binding"),("depth","1","binding"),
    ("market",3,"binding"),("height",0,"malformed"),("height",True,"malformed"),
    ("height","20","malformed"),("height",2**53,"malformed"),("height",1.5,"malformed"),
    ("data","kA==","binding"),("witness",None,"malformed"),("witness",witness(1),"binding")])
def test_book_frame_bindings(field,value,kind):
    frame=book(); frame[field]=value
    with pytest.raises(sdk.GatewayReadError) as err: sdk.decode_finalized_orderbook(frame,3)
    assert err.value.kind == kind


def bad_books():
    for raw in [[],[[]],[[],[],[]],[None,[]],[[[1,2]],[]],[[[1,2,3,4]],[]],
        [[[1,1,1],[1,1,1]],[]],[[[1,1,1],[2,1,1]],[]],[[],[[2,1,1],[1,1,1]]]]: yield raw
    for index in range(3):
        for value in [-1,True,1.0,"1"]:
            row=[1,1,1];row[index]=value;yield [[row],[]]
    yield [[[1,1,2**32]],[]]


@pytest.mark.parametrize("raw",list(bad_books()))
def test_book_malformed_native_payload(raw):
    with pytest.raises(sdk.GatewayReadError) as err: sdk.decode_finalized_orderbook(book(raw),3)
    assert (err.value.kind, err.value.field) == ("malformed", "orderbook.msgpack")


def test_book_depth_limit_and_extra_witness_fields():
    raw=[[[n,1,1] for n in range(100,0,-1)],[]]
    assert len(sdk.decode_finalized_orderbook(book(raw,100),3,100).bids) == 100
    with pytest.raises(sdk.GatewayReadError): sdk.decode_finalized_orderbook(book(raw,20),3,20)
    frame=book();frame["witness"]["extra"]="future";frame["extra"]="future"
    assert sdk.decode_finalized_orderbook(frame,3).height == H


@pytest.mark.parametrize("encoded", ["", "kB==", "kA==\n", "kA", base64.b64encode(b'\x90'*(512*1024+1)).decode()])
def test_book_invalid_bounded_base64(encoded):
    frame=book();frame.update(data=encoded,bookMsgpackB64=encoded)
    with pytest.raises(sdk.GatewayReadError): sdk.decode_finalized_orderbook(frame,3)


def test_markets_snapshot_reuses_existing_typed_model_and_keeps_witness():
    frame=snapshot(); frame["witness"]["extra"]="future"
    result=sdk.decode_finalized_markets_snapshot(frame,chain_id=CHAIN)
    assert isinstance(result,sdk.MarketsSnapshot)
    assert result.height == result.witness.height == 9007199254740993
    assert result.chain_id == CHAIN and result.open_interest[0].long == 9007199254740993
    assert type(result.open_interest[0]) is sdk.MarketOpenInterest
    expected=sdk.decode_markets_snapshot(json.dumps(frame).encode(),CHAIN)
    assert {k:v for k,v in asdict(result).items() if k != "witness"} == asdict(expected)


@pytest.mark.parametrize("change,kind", [("chain","binding"),("uncommitted","binding"),("witnessheight","binding"),("missingwitness","malformed"),
    ("witnessnull","malformed"),("badjson","malformed"),("missingdata","malformed")])
def test_snapshot_mismatches_never_fallback(change,kind):
    frame=snapshot();chain=CHAIN
    if change == "chain":chain=bytes([8])*32
    if change == "uncommitted":
        raw=msgpack.unpackb(base64.b64decode(frame["data"]));raw[1]=0
        frame["data"]=base64.b64encode(msgpack.packb(raw)).decode()
    if change == "witnessheight":frame["witness"]=witness(1)
    if change == "missingwitness":del frame["witness"]
    if change == "witnessnull":frame["witness"]=None
    if change == "badjson":frame["future"]={object()}
    if change == "missingdata":del frame["data"]
    with pytest.raises(sdk.GatewayReadError) as err: sdk.decode_finalized_markets_snapshot(frame,chain_id=chain)
    assert err.value.kind == kind


@pytest.fixture
def client():
    c=sdk.ExchangeClient(config=sdk.SdkConfig(gateway_url="https://gateway.example",api_key="test-key"))
    c._http.close();yield c;c.close()


def serve(client,value,status=200):
    stream=Stream([json.dumps(value).encode()]);calls=[]
    def handler(request):
        calls.append(request);return httpx.Response(status,stream=stream,headers={"X-RateLimit-Remaining":"23"})
    client._http=httpx.Client(transport=httpx.MockTransport(handler),headers=client._default_headers())
    return calls,stream


@pytest.mark.parametrize("method,args,kwargs,frame,path,timeout", [
    ("finalized_orderbook",(3,),{},book(),"/v1/orderbook-snapshot/3?depth=20",5),
    ("finalized_markets_snapshot",(),{"chain_id":CHAIN},snapshot(),"/v1/markets-snapshot",10),
])
def test_managed_bounded_http_no_extra_request(client,method,args,kwargs,frame,path,timeout):
    calls,stream=serve(client,frame); result=getattr(client,method)(*args,**kwargs)
    assert result.witness.height > 0 and len(calls) == 1 and stream.closed
    assert str(calls[0].url) == "https://gateway.example"+path
    assert calls[0].headers["X-API-Key"] == "test-key" and calls[0].headers["Accept-Encoding"] == "identity"
    assert calls[0].extensions["timeout"]["read"] == timeout
    assert client.rate_limit_remaining("default") == 23


@pytest.mark.parametrize("method,args,kwargs",[("finalized_orderbook",(3,),{}),("finalized_markets_snapshot",(),{"chain_id":CHAIN})])
def test_http_error_body_is_discarded_without_fallback(client,method,args,kwargs):
    calls,stream=serve(client,{"error":"unsupported"},503)
    with pytest.raises(sdk.GatewayError):getattr(client,method)(*args,**kwargs)
    assert len(calls)==1 and stream.closed and stream.reads==0


def test_chain_pin_required_before_transport(client):
    calls,_=serve(client,snapshot())
    with pytest.raises(TypeError):client.finalized_markets_snapshot()
    with pytest.raises(sdk.GatewayReadError):client.finalized_markets_snapshot(chain_id="")
    with pytest.raises(sdk.GatewayReadError) as err: client.finalized_markets_snapshot(chain_id=bytes(32))
    assert (err.value.kind, err.value.field) == ("configuration", "chainId")
    assert not calls


from pathlib import Path

_ORDERBOOK_VECTORS = json.loads((Path(__file__).resolve().parents[2] / "conformance/finalized-orderbook.json").read_text())

@pytest.mark.parametrize("case", _ORDERBOOK_VECTORS, ids=lambda case: case["name"])
def test_shared_orderbook_vectors(case):
    frame = {"market": "3", "depth": str(case["depth"]), "height": H,
             "bookMsgpackB64": case.get("payload"), "witness": witness()}
    if "data" in case: frame["data"] = case["data"]
    if "error" in case:
        with pytest.raises(sdk.GatewayReadError) as err:
            sdk.decode_finalized_orderbook(frame, 3, case["depth"])
        assert err.value.kind == case["error"]
    else:
        result = sdk.decode_finalized_orderbook(frame, 3, case["depth"])
        for side in ("bids", "asks"):
            assert [[str(v.price), str(v.total_qty), v.order_count] for v in getattr(result, side)] == case[side]
