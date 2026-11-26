// Three.js r187 - Node System

// global
diagnostic( off, derivative_uniformity );


// directives


// structs

struct OutputStruct {
	@location( 0 ) color: vec4<f32>
};
var<private> output : OutputStruct;

// uniforms
@binding( 1 ) @group( 1 ) var nodeUniform19_sampler : sampler;
@binding( 2 ) @group( 1 ) var nodeUniform19 : texture_2d<f32>;

struct objectStruct {
	nodeUniform0 : vec3<f32>,
	nodeUniform1 : f32,
	nodeUniform2 : f32,
	nodeUniform3 : f32,
	nodeUniform5 : mat3x3<f32>,
	nodeUniform6 : f32,
	nodeUniform7 : vec3<f32>,
	nodeUniform8 : f32,
	nodeUniform9 : f32,
	nodeUniform10 : f32,
	nodeUniform11 : vec3<f32>,
	nodeUniform12 : f32,
	nodeUniform13 : f32,
	nodeUniform14 : f32,
	nodeUniform15 : f32,
	nodeUniform16 : f32,
	nodeUniform17 : vec3<f32>,
	nodeUniform18 : f32,
	nodeUniform20 : mat4x4<f32>
};
@binding( 0 ) @group( 1 )
var<uniform> object : objectStruct;

struct renderStruct {
	cameraProjectionMatrix : mat4x4<f32>,
	cameraViewMatrix : mat4x4<f32>,
	nodeUniform24 : vec3<f32>,
	nodeUniform26 : vec3<f32>,
	nodeUniform27 : vec3<f32>,
	nodeUniform25 : vec3<f32>,
	nodeUniform22 : vec3<f32>,
	nodeUniform23 : vec3<f32>
};
@binding( 0 ) @group( 0 )
var<uniform> render : renderStruct;

// vars
var<private> DiffuseColor : vec4<f32>;
var<private> Metalness : f32;
var<private> Roughness : f32;
var<private> normalViewGeometry : vec3<f32>;
var<private> IOR : f32;
var<private> SpecularColor : vec3<f32>;
var<private> SpecularColorBlended : vec3<f32>;
var<private> SpecularF90 : f32;
var<private> DiffuseContribution : vec3<f32>;
var<private> Clearcoat : f32;
var<private> ClearcoatRoughness : f32;
var<private> Sheen : vec3<f32>;
var<private> SheenRoughness : f32;
var<private> Iridescence : f32;
var<private> IridescenceIOR : f32;
var<private> IridescenceThickness : f32;
var<private> EmissiveColor : vec3<f32>;
var<private> Output : vec4<f32>;
var<private> clearcoatRadiance : vec3<f32>;
var<private> clearcoatSpecularDirect : vec3<f32>;
var<private> clearcoatSpecularIndirect : vec3<f32>;
var<private> sheenSpecularDirect : vec3<f32>;
var<private> sheenSpecularIndirect : vec3<f32>;
var<private> NORMAL_normalView : vec3<f32>;
var<private> normalView : vec3<f32>;
var<private> positionViewDirection : vec3<f32>;
var<private> nodeVar0 : vec2<f32>;
var<private> singleScatteringDielectric : vec3<f32>;
var<private> multiScatteringDielectric : vec3<f32>;
var<private> nodeVar1 : vec3<f32>;
var<private> clearcoatNormalView : vec3<f32>;
var<private> directDiffuse : vec3<f32>;
var<private> directSpecular : vec3<f32>;
var<private> irradiance : vec3<f32>;
var<private> normalWorld : vec3<f32>;
var<private> nodeVar2 : vec3<f32>;
var<private> indirectDiffuse : vec3<f32>;
var<private> iblIrradiance : vec3<f32>;
var<private> nodeVar3 : vec2<f32>;
var<private> singleScatteringMetallic : vec3<f32>;
var<private> multiScatteringMetallic : vec3<f32>;
var<private> radiance : vec3<f32>;
var<private> nodeVar4 : vec3<f32>;
var<private> nodeVar5 : vec3<f32>;
var<private> indirectSpecular : vec3<f32>;
var<private> ambientOcclusion : f32;
var<private> totalDiffuse : vec3<f32>;
var<private> totalSpecular : vec3<f32>;
var<private> outgoingLight : vec3<f32>;

// codes
fn fn127 ( outsideIOR : f32, eta2 : f32, cosTheta1 : f32, thinFilmThickness : f32, baseF0 : vec3<f32> ) -> vec3<f32> {

	var nodeVar0 : vec3<f32>;
	var nodeVar1 : vec3<f32>;
	var nodeVar2 : f32;
	var nodeVar3 : f32;
	var nodeVar4 : f32;
	var nodeVar5 : f32;

	let nodeConst0 = mix( outsideIOR, eta2, smoothstep( 0.0, 0.03, thinFilmThickness ) );
	let nodeConst1 = ( outsideIOR / nodeConst0 );
	let nodeConst2 = ( 1.0 - ( ( nodeConst1 * nodeConst1 ) * ( 1.0 - ( cosTheta1 * cosTheta1 ) ) ) );

	if ( ( nodeConst2 < 0.0 ) ) {

		return vec3<f32>( 1.0, 1.0, 1.0 );

	}

	let nodeConst3 = ( ( nodeConst0 - outsideIOR ) / ( nodeConst0 + outsideIOR ) );
	let nodeConst4 = exp2( ( ( ( cosTheta1 * -5.55473 ) - 6.98316 ) * cosTheta1 ) );
	let nodeConst5 = ( ( ( nodeConst3 * nodeConst3 ) * ( 1.0 - nodeConst4 ) ) + ( 1.0 * nodeConst4 ) );
	let nodeConst6 = ( 1.0 - nodeConst5 );
	let nodeConst7 = sqrt( clamp( baseF0, vec3<f32>( 0.0 ), vec3<f32>( 0.9999 ) ) );
	let nodeConst8 = ( ( vec3<f32>( 1.0, 1.0, 1.0 ) + nodeConst7 ) / ( vec3<f32>( 1.0, 1.0, 1.0 ) - nodeConst7 ) );
	let nodeConst9 = vec3<f32>( nodeConst0 );
	let nodeConst10 = ( ( nodeConst8 - nodeConst9 ) / ( nodeConst8 + nodeConst9 ) );
	let nodeConst11 = sqrt( nodeConst2 );
	let nodeConst12 = exp2( ( ( ( nodeConst11 * -5.55473 ) - 6.98316 ) * nodeConst11 ) );
	let nodeConst13 = ( ( ( nodeConst10 * nodeConst10 ) * vec3<f32>( ( 1.0 - nodeConst12 ) ) ) + vec3<f32>( ( 1.0 * nodeConst12 ) ) );
	let nodeConst14 = clamp( ( vec3<f32>( nodeConst5 ) * nodeConst13 ), vec3<f32>( 0.00001 ), vec3<f32>( 0.9999 ) );
	let nodeConst15 = ( ( vec3<f32>( ( nodeConst6 * nodeConst6 ) ) * nodeConst13 ) / ( vec3<f32>( 1.0, 1.0, 1.0 ) - nodeConst14 ) );
	nodeVar0 = ( vec3<f32>( nodeConst5 ) + nodeConst15 );
	nodeVar1 = ( nodeConst15 - vec3<f32>( nodeConst6 ) );

	for ( var m : i32 = 1; m <= 2; m ++ ) {

		nodeVar1 = ( nodeVar1 * sqrt( nodeConst14 ) );
		let nodeConst16 = ( ( f32( m ) * ( ( ( nodeConst0 * thinFilmThickness ) * nodeConst11 ) * 2.0 ) ) * 6.283185307179586e-9 );

		if ( ( nodeConst0 < outsideIOR ) ) {

			nodeVar2 = 3.141592653589793;

		} else {

			nodeVar2 = 0.0;

		}


		if ( ( nodeConst8.x < nodeConst0 ) ) {

			nodeVar3 = 3.141592653589793;

		} else {

			nodeVar3 = 0.0;

		}


		if ( ( nodeConst8.y < nodeConst0 ) ) {

			nodeVar4 = 3.141592653589793;

		} else {

			nodeVar4 = 0.0;

		}


		if ( ( nodeConst8.z < nodeConst0 ) ) {

			nodeVar5 = 3.141592653589793;

		} else {

			nodeVar5 = 0.0;

		}

		let nodeConst17 = ( vec3<f32>( f32( m ) ) * ( vec3<f32>( ( 3.141592653589793 - nodeVar2 ) ) + vec3<f32>( nodeVar3, nodeVar4, nodeVar5 ) ) );
		let nodeConst18 = ( ( ( vec3<f32>( 5.4856e-13, 4.4201e-13, 5.2481e-13 ) * sqrt( ( vec3<f32>( 4327800000.0, 9304600000.0, 6612100000.0 ) * vec3<f32>( 6.283185307179586 ) ) ) ) * cos( ( ( vec3<f32>( 1681000.0, 1795300.0, 2208400.0 ) * vec3<f32>( nodeConst16 ) ) + nodeConst17 ) ) ) * exp( ( vec3<f32>( ( - ( nodeConst16 * nodeConst16 ) ) ) * vec3<f32>( 4327800000.0, 9304600000.0, 6612100000.0 ) ) ) );
		nodeVar0 = ( nodeVar0 + ( nodeVar1 * ( ( mat3x3<f32>( 3.2404542, -0.969266, 0.0556434, -1.5371385, 1.8760108, -0.2040259, -0.4985314, 0.041556, 1.0572252 ) * ( vec3<f32>( ( nodeConst18.x + ( ( 1.6440828550896444e-8 * cos( ( ( nodeConst16 * 2239900.0 ) + nodeConst17.x ) ) ) * exp( ( ( nodeConst16 * nodeConst16 ) * -4528200000.0 ) ) ) ), nodeConst18.y, nodeConst18.z ) / vec3<f32>( 1.0685e-7 ) ) ) * vec3<f32>( 2.0 ) ) ) );

	}


	return max( nodeVar0, vec3<f32>( 0.0, 0.0, 0.0 ) );

}


fn fn116 ( f : vec3<f32>, f90 : f32, dotVH : f32 ) -> vec3<f32> {

	

	let nodeConst0 = clamp( ( 1.0 - dotVH ), 0.0, 1.0 );
	let nodeConst1 = ( nodeConst0 * nodeConst0 );
	let nodeConst2 = clamp( ( ( nodeConst0 * nodeConst1 ) * nodeConst1 ), 0.0, 0.9999 );

	return ( ( f - ( vec3<f32>( f90 ) * vec3<f32>( nodeConst2 ) ) ) / vec3<f32>( ( 1.0 - nodeConst2 ) ) );

}


fn fn114 ( roughness : f32, dotNH : f32 ) -> f32 {

	

	let nodeConst0 = ( 1.0 / ( roughness * roughness ) );

	return ( ( ( 2.0 + nodeConst0 ) * pow( max( ( 1.0 - ( dotNH * dotNH ) ), 0.0078125 ), ( nodeConst0 * 0.5 ) ) ) / 6.283185307179586 );

}


fn fn115 ( dotNV : f32, dotNL : f32 ) -> f32 {

	


	return clamp( ( 1.0 / ( 4.0 * ( ( dotNL + dotNV ) - ( dotNL * dotNV ) ) ) ), 0.0, 1.0 );

}


fn fn128 ( normal : vec3<f32>, viewDir : vec3<f32>, roughness : f32 ) -> f32 {

	

	let nodeConst0 = ( roughness * roughness );
	let nodeConst1 = ( 1.0 / ( roughness + 0.1 ) );

	return clamp( exp( ( ( ( ( ( -1.9362 + ( roughness * 1.0678 ) ) + ( nodeConst0 * 0.4573 ) ) - ( nodeConst1 * 0.8469 ) ) * clamp( dot( normal, viewDir ), 0.0, 1.0 ) ) + ( ( ( -0.6014 + ( roughness * 0.5538 ) ) - ( nodeConst0 * 0.467 ) ) - ( nodeConst1 * 0.1255 ) ) ) ), 0.0, 1.0 );

}


fn fn110 ( alpha : f32, dotNL : f32, dotNV : f32 ) -> f32 {

	

	let nodeConst0 = ( alpha * alpha );

	return ( 0.5 / max( ( ( dotNL * sqrt( ( nodeConst0 + ( ( 1.0 - nodeConst0 ) * ( dotNV * dotNV ) ) ) ) ) + ( dotNV * sqrt( ( nodeConst0 + ( ( 1.0 - nodeConst0 ) * ( dotNL * dotNL ) ) ) ) ) ), 0.000001 ) );

}


fn fn112 ( alpha : f32, dotNH : f32 ) -> f32 {

	

	let nodeConst0 = ( alpha * alpha );
	let nodeConst1 = ( 1.0 - ( ( dotNH * dotNH ) * ( 1.0 - nodeConst0 ) ) );

	return ( ( nodeConst0 / ( nodeConst1 * nodeConst1 ) ) * 0.3183098861837907 );

}




@fragment
fn main( @location( 0 ) v_normalViewGeometry : vec3<f32>,
	@location( 1 ) v_positionViewDirection : vec3<f32> ) -> OutputStruct {

	// flow
	// code

	DiffuseColor = vec4<f32>( object.nodeUniform0, 1.0 );
	DiffuseColor.w = ( DiffuseColor.w * object.nodeUniform1 );
	DiffuseColor.w = 1.0;
	Metalness = object.nodeUniform2;
	normalViewGeometry = normalize( v_normalViewGeometry );
	let nodeConst0 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	Roughness = min( ( max( object.nodeUniform3, 0.045 ) + max( max( nodeConst0.x, nodeConst0.y ), nodeConst0.z ) ), 1.0 );
	IOR = object.nodeUniform6;
	let nodeConst1 = ( ( IOR - 1.0 ) / ( IOR + 1.0 ) );
	SpecularColor = ( min( ( vec3<f32>( ( nodeConst1 * nodeConst1 ) ) * object.nodeUniform7 ), vec3<f32>( 1.0, 1.0, 1.0 ) ) * vec3<f32>( object.nodeUniform8 ) );
	SpecularColorBlended = mix( SpecularColor, DiffuseColor.xyz, Metalness );
	SpecularF90 = mix( object.nodeUniform8, 1.0, Metalness );
	DiffuseContribution = ( DiffuseColor.xyz * vec3<f32>( ( 1.0 - object.nodeUniform2 ) ) );
	Clearcoat = object.nodeUniform9;
	let nodeConst2 = max( abs( dpdx( normalViewGeometry ) ), abs( - dpdy( normalViewGeometry ) ) );
	ClearcoatRoughness = min( ( max( object.nodeUniform10, 0.045 ) + max( max( nodeConst2.x, nodeConst2.y ), nodeConst2.z ) ), 1.0 );
	Sheen = ( object.nodeUniform11 * vec3<f32>( object.nodeUniform12 ) );
	SheenRoughness = clamp( object.nodeUniform13, 0.0001, 1.0 );
	Iridescence = object.nodeUniform14;
	IridescenceIOR = object.nodeUniform15;
	IridescenceThickness = object.nodeUniform16;
	EmissiveColor = ( object.nodeUniform17 * vec3<f32>( object.nodeUniform18 ) );
	clearcoatRadiance = vec3<f32>( 0.0, 0.0, 0.0 );
	clearcoatSpecularDirect = vec3<f32>( 0.0, 0.0, 0.0 );
	clearcoatSpecularIndirect = vec3<f32>( 0.0, 0.0, 0.0 );
	sheenSpecularDirect = vec3<f32>( 0.0, 0.0, 0.0 );
	sheenSpecularIndirect = vec3<f32>( 0.0, 0.0, 0.0 );
	NORMAL_normalView = normalViewGeometry;
	normalView = NORMAL_normalView;
	positionViewDirection = normalize( v_positionViewDirection );
	nodeVar0 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( Roughness, clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ).xy;
	let dfg = nodeVar0;
	let multiScatteringCompensation = ( ( SpecularColorBlended * vec3<f32>( ( ( 1.0 / ( dfg.x + dfg.y ) ) - 1.0 ) ) ) + vec3<f32>( 1.0 ) );
	singleScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringDielectric = vec3<f32>( 0.0, 0.0, 0.0 );
	let nodeConst3 = clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 );
	let nodeConst4 = fn127( 1.0, IridescenceIOR, nodeConst3, IridescenceThickness, SpecularColor );
	let nodeConst5 = mix( SpecularColor, fn116( nodeConst4, 1.0, nodeConst3 ), Iridescence );
	let nodeConst6 = ( ( nodeConst5 * vec3<f32>( dfg.x ) ) + vec3<f32>( ( SpecularF90 * dfg.y ) ) );
	singleScatteringDielectric = ( singleScatteringDielectric + nodeConst6 );
	let nodeConst7 = ( nodeConst5 + ( ( vec3<f32>( 1.0 ) - nodeConst5 ) * vec3<f32>( 0.047619 ) ) );
	let nodeConst8 = ( 1.0 - ( dfg.x + dfg.y ) );
	multiScatteringDielectric = ( multiScatteringDielectric + ( ( ( nodeConst6 * nodeConst7 ) / ( vec3<f32>( 1.0 ) - ( vec3<f32>( nodeConst8 ) * nodeConst7 ) ) ) * vec3<f32>( nodeConst8 ) ) );
	let nodeConst9 = normalize( ( render.cameraViewMatrix * vec4<f32>( ( render.nodeUniform22 - render.nodeUniform23 ), 0.0 ) ).xyz );
	nodeVar1 = ( vec3<f32>( clamp( dot( normalView, nodeConst9 ), 0.0, 1.0 ) ) * render.nodeUniform24 );
	sheenSpecularDirect = ( sheenSpecularDirect + ( nodeVar1 * ( ( Sheen * vec3<f32>( fn114( SheenRoughness, clamp( dot( normalView, normalize( ( nodeConst9 + positionViewDirection ) ) ), 0.0, 1.0 ) ) ) ) * vec3<f32>( fn115( clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ), clamp( dot( normalView, nodeConst9 ), 0.0, 1.0 ) ) ) ) ) );
	nodeVar1 = ( nodeVar1 * vec3<f32>( ( 1.0 - ( max( max( Sheen.x, Sheen.y ), Sheen.z ) * max( fn128( normalView, positionViewDirection, SheenRoughness ), fn128( normalView, nodeConst9, SheenRoughness ) ) ) ) ) );
	clearcoatNormalView = NORMAL_normalView;
	let nodeConst10 = normalize( ( nodeConst9 + positionViewDirection ) );
	let nodeConst11 = clamp( dot( positionViewDirection, nodeConst10 ), 0.0, 1.0 );
	let nodeConst12 = exp2( ( ( ( nodeConst11 * -5.55473 ) - 6.98316 ) * nodeConst11 ) );
	let nodeConst13 = max( ClearcoatRoughness, 0.045 );
	let nodeConst14 = ( nodeConst13 * nodeConst13 );
	clearcoatSpecularDirect = ( clearcoatSpecularDirect + ( ( vec3<f32>( clamp( dot( clearcoatNormalView, nodeConst9 ), 0.0, 1.0 ) ) * render.nodeUniform24 ) * ( ( ( ( vec3<f32>( 0.04, 0.04, 0.04 ) * vec3<f32>( ( 1.0 - nodeConst12 ) ) ) + vec3<f32>( ( 1.0 * nodeConst12 ) ) ) * vec3<f32>( fn110( nodeConst14, clamp( dot( clearcoatNormalView, nodeConst9 ), 0.0, 1.0 ), clamp( dot( clearcoatNormalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( fn112( nodeConst14, clamp( dot( clearcoatNormalView, nodeConst10 ), 0.0, 1.0 ) ) ) ) ) );
	directDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	let nodeConst15 = clamp( dot( positionViewDirection, normalize( ( nodeConst9 + positionViewDirection ) ) ), 0.0, 1.0 );
	let nodeConst16 = exp2( ( ( ( nodeConst15 * -5.55473 ) - 6.98316 ) * nodeConst15 ) );
	directDiffuse = ( directDiffuse + ( ( nodeVar1 * ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) ) ) * ( vec3<f32>( 1.0 ) - ( ( SpecularColor * vec3<f32>( ( 1.0 - nodeConst16 ) ) ) + vec3<f32>( ( SpecularF90 * nodeConst16 ) ) ) ) ) );
	directSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	let nodeConst17 = normalize( ( nodeConst9 + positionViewDirection ) );
	let nodeConst18 = clamp( dot( positionViewDirection, nodeConst17 ), 0.0, 1.0 );
	let nodeConst19 = exp2( ( ( ( nodeConst18 * -5.55473 ) - 6.98316 ) * nodeConst18 ) );
	let nodeConst20 = fn127( 1.0, IridescenceIOR, nodeConst3, IridescenceThickness, DiffuseColor.xyz );
	let nodeConst21 = max( Roughness, 0.045 );
	let nodeConst22 = ( nodeConst21 * nodeConst21 );
	directSpecular = ( directSpecular + ( ( nodeVar1 * ( ( mix( ( ( SpecularColorBlended * vec3<f32>( ( 1.0 - nodeConst19 ) ) ) + vec3<f32>( ( SpecularF90 * nodeConst19 ) ) ), mix( nodeConst4, nodeConst20, Metalness ), Iridescence ) * vec3<f32>( fn110( nodeConst22, clamp( dot( normalView, nodeConst9 ), 0.0, 1.0 ), clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) ) ) ) * vec3<f32>( fn112( nodeConst22, clamp( dot( normalView, nodeConst17 ), 0.0, 1.0 ) ) ) ) ) * multiScatteringCompensation ) );
	irradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	normalWorld = normalize( ( vec4<f32>( normalView, 0.0 ) * render.cameraViewMatrix ).xyz );
	irradiance = ( irradiance + mix( render.nodeUniform25, render.nodeUniform26, ( ( dot( normalWorld, normalize( render.nodeUniform27 ) ) * 0.5 ) + 0.5 ) ) );
	nodeVar2 = ( ( irradiance * ( DiffuseContribution * vec3<f32>( 0.3183098861837907 ) ) ) * ( vec3<f32>( 1.0 ) - ( singleScatteringDielectric + multiScatteringDielectric ) ) );
	let nodeConst23 = fn128( normalView, positionViewDirection, SheenRoughness );
	sheenSpecularIndirect = ( sheenSpecularIndirect + ( ( ( irradiance * Sheen ) * vec3<f32>( nodeConst23 ) ) * vec3<f32>( 0.3183098861837907 ) ) );
	nodeVar2 = ( nodeVar2 * vec3<f32>( ( 1.0 - ( max( max( Sheen.x, Sheen.y ), Sheen.z ) * nodeConst23 ) ) ) );
	indirectDiffuse = vec3<f32>( 0.0, 0.0, 0.0 );
	indirectDiffuse = ( indirectDiffuse + nodeVar2 );
	iblIrradiance = vec3<f32>( 0.0, 0.0, 0.0 );
	sheenSpecularIndirect = ( sheenSpecularIndirect + ( ( ( iblIrradiance * Sheen ) * vec3<f32>( fn128( normalView, positionViewDirection, SheenRoughness ) ) ) * vec3<f32>( 0.3183098861837907 ) ) );
	nodeVar3 = textureSample( nodeUniform19, nodeUniform19_sampler, vec2<f32>( ClearcoatRoughness, clamp( dot( clearcoatNormalView, positionViewDirection ), 0.0, 1.0 ) ) ).xy;
	clearcoatSpecularIndirect = ( clearcoatSpecularIndirect + ( clearcoatRadiance * ( ( vec3<f32>( 0.04, 0.04, 0.04 ) * vec3<f32>( nodeVar3.x ) ) + vec3<f32>( ( 1.0 * nodeVar3.y ) ) ) ) );
	singleScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	multiScatteringMetallic = vec3<f32>( 0.0, 0.0, 0.0 );
	let nodeConst24 = mix( DiffuseColor.xyz, fn116( nodeConst20, 1.0, nodeConst3 ), Iridescence );
	let nodeConst25 = ( ( nodeConst24 * vec3<f32>( dfg.x ) ) + vec3<f32>( ( SpecularF90 * dfg.y ) ) );
	singleScatteringMetallic = ( singleScatteringMetallic + nodeConst25 );
	let nodeConst26 = ( nodeConst24 + ( ( vec3<f32>( 1.0 ) - nodeConst24 ) * vec3<f32>( 0.047619 ) ) );
	let nodeConst27 = ( 1.0 - ( dfg.x + dfg.y ) );
	multiScatteringMetallic = ( multiScatteringMetallic + ( ( ( nodeConst25 * nodeConst26 ) / ( vec3<f32>( 1.0 ) - ( vec3<f32>( nodeConst27 ) * nodeConst26 ) ) ) * vec3<f32>( nodeConst27 ) ) );
	radiance = vec3<f32>( 0.0, 0.0, 0.0 );
	let nodeConst28 = ( iblIrradiance * vec3<f32>( 0.3183098861837907 ) );
	nodeVar4 = ( ( radiance * mix( singleScatteringDielectric, singleScatteringMetallic, Metalness ) ) + ( mix( multiScatteringDielectric, multiScatteringMetallic, Metalness ) * nodeConst28 ) );
	nodeVar5 = ( ( DiffuseContribution * ( vec3<f32>( 1.0 ) - ( singleScatteringDielectric + multiScatteringDielectric ) ) ) * nodeConst28 );
	let nodeConst29 = ( 1.0 - ( max( max( Sheen.x, Sheen.y ), Sheen.z ) * fn128( normalView, positionViewDirection, SheenRoughness ) ) );
	nodeVar4 = ( nodeVar4 * vec3<f32>( nodeConst29 ) );
	nodeVar5 = ( nodeVar5 * vec3<f32>( nodeConst29 ) );
	indirectSpecular = vec3<f32>( 0.0, 0.0, 0.0 );
	indirectSpecular = ( indirectSpecular + nodeVar4 );
	indirectDiffuse = ( indirectDiffuse + nodeVar5 );
	ambientOcclusion = 1.0;
	clearcoatSpecularIndirect = ( clearcoatSpecularIndirect * vec3<f32>( ambientOcclusion ) );
	sheenSpecularIndirect = ( sheenSpecularIndirect * vec3<f32>( ambientOcclusion ) );
	indirectDiffuse = ( indirectDiffuse * vec3<f32>( ambientOcclusion ) );
	indirectSpecular = ( indirectSpecular * vec3<f32>( clamp( ( ambientOcclusion - ( 1.0 - pow( ( clamp( dot( normalView, positionViewDirection ), 0.0, 1.0 ) + ambientOcclusion ), exp2( ( - ( 1.0 - ( Roughness * -16.0 ) ) ) ) ) ) ), 0.0, 1.0 ) ) );
	totalDiffuse = ( directDiffuse + indirectDiffuse );
	totalSpecular = ( directSpecular + indirectSpecular );
	outgoingLight = ( totalDiffuse + totalSpecular );
	let nodeConst30 = clamp( dot( clearcoatNormalView, positionViewDirection ), 0.0, 1.0 );
	let nodeConst31 = exp2( ( ( ( nodeConst30 * -5.55473 ) - 6.98316 ) * nodeConst30 ) );
	outgoingLight = ( ( outgoingLight * ( vec3<f32>( 1.0 ) - ( vec3<f32>( Clearcoat ) * ( ( vec3<f32>( 0.04, 0.04, 0.04 ) * vec3<f32>( ( 1.0 - nodeConst31 ) ) ) + vec3<f32>( ( 1.0 * nodeConst31 ) ) ) ) ) ) + ( ( clearcoatSpecularDirect + clearcoatSpecularIndirect ) * vec3<f32>( Clearcoat ) ) );
	outgoingLight = ( ( outgoingLight + sheenSpecularDirect ) + sheenSpecularIndirect );
	let nodeConst32 = max( vec4<f32>( ( outgoingLight + EmissiveColor ), DiffuseColor.w ), vec4<f32>( 0.0 ) );
	Output = nodeConst32;

	// result

	output.color = nodeConst32;

	return output;

}
